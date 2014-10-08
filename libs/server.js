/**
* The server is a web server that handles three main tasks:
*   1) It provides an endpoint for users to upload their files to the workers, through wh deploy
*   2) It provides endpoints for users to upload files to their buckets from their CMS
*   3) It provides endpoints for users to access the elastic search data for their site
*
* Almost all requests to the server require some sort of authentication, normally in the form of
* site name + site token.
*/

var express = require('express');
var colors = require('colors');
var Zip   = require('adm-zip');
var request = require('request');
var fs = require('fs');
var mkdirp = require('mkdirp');
var fireUtil = require('./firebase-util.js');
var wrench = require('wrench');
var path = require('path');
var cloudStorage = require('./cloudStorage.js');
var backupExtractor = require('./backupExtractor.js');
var temp = require('temp');
var mime = require('mime');
var ElasticSearchClient = require('elasticsearchclient');
var archiver   = require('archiver');

// Some string functions worth having
String.prototype.endsWith = function(suffix) {
    return this.indexOf(suffix, this.length - suffix.length) !== -1;
};

String.prototype.startsWith = function (str){
  return this.indexOf(str) == 0;
};

// Used to generate GUIDs for random uses
function uniqueId() {
  return Date.now() + 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  }); 
}

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

// General error handling function
function errorHandler(err, req, res, next) {
  res.status(500);
  res.send('error');
}

// Cleans up any files that may have been posted to
// the server in req, used to clean up uploads
var cleanUpFiles = function(req) {
  var curFile = null;
  for(var key in req.files) {
    if(req.files[key].path) {
      try {
        fs.unlinkSync(req.files[key].path);
      } catch (e) {
        // Ignore, just last minute trying to unlink
      }
    }
  }
}

module.exports.start = function(config, logger)
{
  if (config.get('newrelicEnabled')) {
    require('newrelic');
  }

  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));
  fireUtil.configUtils(config);

  var firebaseUrl = config.get('firebase') || '';
  var app = express();

  var serverName = config.get('elasticServer').replace('http://', '').replace('https://', '');
  serverName = serverName.split(':')[0];
  var elasticOptions = {
      host: serverName,
      port: 9200,
      auth: {
        username: config.get('elasticUser'),
        password: config.get('elasticPassword')
    }
  };

  var elastic = new ElasticSearchClient(elasticOptions);
  
  // We do this to allow for CORS requests to the server (for search)
  var allowCrossDomain = function(req, res, next) {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
      res.header('Access-Control-Allow-Headers', 'Content-Type');

      if ('OPTIONS' == req.method) {
        res.send(200);
      } else {
        next();
      }
  };

  // Set up our request handlers for express
  app.use(express.limit('1024mb'));
  app.use(express.bodyParser({ maxFieldsSize: 10 * 1024 * 1024 }));
  app.use(allowCrossDomain);
  app.use(errorHandler);

  var firebaseRoot = 'https://' + firebaseUrl +  '.firebaseio.com';

  // Used to know that the program is working
  app.get('/', function(req, res) {
    res.send('Working...');
  });

  // Request for backup snapshots, passed a token, sitename, and a timestamp
  // If the token matches the token for the site on record, returns
  // a backup for the given site
  app.get('/backup-snapshot/', function(req, res) {
    var token = req.query.token;
    var timestamp = req.query.timestamp;
    var site = req.query.site;

    fireUtil.get(firebaseRoot + '/management/sites/' + site + '/', function(data) {
      if(!data) {
        res.status(404);
        res.end();
      }
      
      if(data.key === token)
      {
        fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {

          // Billing, if not active block access
          if(active === false) {
            res.status(404);
            res.end();
          }

          // Pipe backup to response stream
          cloudStorage.getToken(function() {
            var backupStream = cloudStorage.objects.getStream(config.get('backupBucket'), 'backup-' + timestamp);
            var extractor = backupExtractor.getParser(['buckets', site, token, 'dev']);

            backupStream.pipe(extractor).pipe(res);
          });
        });
      } else {
        res.status(404);
        res.end();
      }
    });

  });

  // Handles uploading a file from a url
  // Post body contains site, token, resize_url, and url
  // site and token are the site and token for the site to upload to
  // resize_url is passed if the url is of an image and needs a resize_url returned
  // Finally url is the url of the object to upload
  app.post('/upload-url/', function(req, res) {

    var site = req.body.site;
    var token = req.body.token;
    var resizeUrlRequested = req.body.resize_url || false;
    var url = req.body.url; 
    var originReq = req;

    // If no url, get out of here
    if(!url) {
      cleanUpFiles(originReq);
      res.json(500, {});
      return;
    }

    fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {
      // If not active, get out of here
      if(active === false) {
        cleanUpFiles(originReq);
        res.json(404);
        res.end();
        return;
      }

      fireUtil.get(firebaseRoot + '/management/sites/' + site + '/', function(data) {

        if(!data) {
          cleanUpFiles(originReq);
          res.status(404);
          res.end();
          return;
        }
        
        if(data.key === token)
        {
          // Where to upload to
          var siteBucket = unescapeSite(site);

          // Create a temporary file to pipe the url data into
          temp.open({ prefix: 'uploads', dir: '/tmp' }, function(err, info) {
            var fp = info.path;

            // Check to see if url is a valid url
            try {
              var req = request(url);
            } catch (e) {
              cleanUpFiles(originReq);
              res.json(500, { error: err});
              return;
            }

            var requestFailed = false;
            // Request the URL and pipe into our temporary file
            req.on('response', function (response) {
              if (!response || response.statusCode !== 200) {
                requestFailed = true;
                fs.unlinkSync(fp);
                cleanUpFiles(originReq);
                res.json(500, { error: err});
              }
            })
            .pipe(fs.createWriteStream(fp))
            .on('close', function () {
              if (requestFailed) {
                cleanUpFiles(originReq);
                return;
              }

              // Once we've stored it in a temporary file, upload file to site
              var fileName = path.basename(url);
              var timestamp = new Date().getTime();
              fileName = timestamp + '_' + fileName;

              var stat = fs.statSync(fp);

              // Size limit of 50MB
              if(stat.size > (50 * 1024 * 1024)) {
                fs.unlinkSync(fp);
                cleanUpFiles(originReq);
                res.json(500, { error: 'File too large. 50 MB is limit.' });
              } else {

                var mimeType = mime.lookup(url);

                // Upload to cloud storage with caching enabled
                cloudStorage.objects.upload(siteBucket, fp, 'webhook-uploads/' + fileName, 'public,max-age=86400', mimeType, function(err, data) {
                  fs.unlinkSync(fp); // Remove temp file
                  if(err) {
                    cleanUpFiles(originReq);
                    res.json(500, { error: err});
                  } else {

                    // If resize url requested, send request to Google App for resize url
                    if(resizeUrlRequested) {
                      request('http://' + config.get('googleProjectId') + '.appspot.com/' + siteBucket + '/webhook-uploads/' + encodeURIComponent(fileName), function(err, data, body) {
                        var resizeUrl = '';

                        if(data && data.statusCode === 200) {
                          resizeUrl = body;
                        }

                        cleanUpFiles(originReq);
                        res.json(200, { 
                          'message' : 'Finished', 
                          'url' : '/webhook-uploads/' + encodeURIComponent(fileName), 
                          'size' : stat.size, 
                          'mimeType' : mimeType,
                          'resize_url' : resizeUrl
                        });

                      });
                    } else {
                      cleanUpFiles(originReq);
                      res.json(200, { 
                        'message' : 'Finished', 
                        'url' : '/webhook-uploads/' + encodeURIComponent(fileName), 
                        'size' : stat.size, 
                        'mimeType' : mimeType 
                      });
                    }

                  }
                });
              }
            });
          });
        } else {
          cleanUpFiles(originReq);
          res.json(401, {'error' : 'Invalid token'});
        }

      });

    });
  });

  // Handles uploading a file posted directly to the server
  // Post body contains site, token, resize_url, and file payload
  // site and token are the site and token for the site to upload to
  // resize_url is passed if the url is of an image and needs a resize_url returned
  // Finally the payload is the file being posted to the server
  app.post('/upload-file/', function(req, res) {

    var site = req.body.site;
    var token = req.body.token;
    var resizeUrlRequested = req.body.resize_url || false;
    var payload = req.files.payload; 

    // 50 MB file size limit
    if(payload.size > (50 * 1024 * 1024)) 
    {
      res.json('500', { error: 'File too large. 50 MB is limit.' });
      cleanUpFiles(req);
    } else {
      fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {
        // If site not active, abort
        if(active === false) {
          cleanUpFiles(req);
          res.json(404);
          res.end();
          return;
        }

        fireUtil.get(firebaseRoot + '/management/sites/' + site + '/', function(data) {

          if(!data) {
            cleanUpFiles(req);
            res.status(404);
            res.end();
            return;
          }
          
          if(data.key === token)
          {
            // Bucket to upload to
            var siteBucket = unescapeSite(site);

            var origFilename = path.basename(payload.originalFilename);
            var timestamp = new Date().getTime();
            var fileName = timestamp + '_' + origFilename;

            // Upload to cloud storage with caching
            cloudStorage.objects.upload(siteBucket, payload.path, 'webhook-uploads/' + fileName, 'public,max-age=86400', function(err, data) { 

              if(err) {
                cleanUpFiles(req);
                res.json(500, { error: err});
              } else {
                var mimeType = mime.lookup(payload.path);

                cleanUpFiles(req);
                // If resize url needed, send request to google app engine app
                if(resizeUrlRequested) {
                  request('http://' + config.get('googleProjectId') + '.appspot.com/' + siteBucket + '/webhook-uploads/' + encodeURIComponent(fileName), function(err, data, body) {
                    var resizeUrl = '';

                    if(data && data.statusCode === 200) {
                      resizeUrl = body;
                    }
                    
                    res.json(200, { 'message' : 'Finished', 'url' : '/webhook-uploads/' + encodeURIComponent(fileName), 'resize_url' : resizeUrl });
                  });
                } else {
                  res.json(200, { 'message' : 'Finished', 'url' : '/webhook-uploads/' + encodeURIComponent(fileName) });
                }
              }
            });
          } else {
            cleanUpFiles(req);
            res.json(401, {'error' : 'Invalid token'});
          }

        });
      });
    }
  });

  /*
  * Performs a search against elastic for the given query on the given typeName
  *
  * @param site     The site to perform the search for
  * @param query    The query being executed
  * @param page     The page to return
  * @param typeName The type to restrict search to (null if all)
  * @param callback Function to call with results
  */
  var searchElastic = function(site, query, page, typeName, callback) {

    if(!query.endsWith('*')) {
      query = query + '*';
    }

    if(!query.startsWith('*')) {
      query = '*' + query;
    }

    if(page < 1) {
      page = 1;
    }

    var qryObj = {
        "query" : {
            "query_string" : { 
              "fields" : ["name^5", "_all"],
              "query" : query 
            }
        },
        "from": (page - 1) * 10,
        "size": 10,
        "fields": ['name','__oneOff'],
        "highlight" : { "fields" : { "*" : {} }, "encoder": "html" }
    };

    if(typeName) {
      elastic.search(site, typeName, qryObj)
          .on('data', function(data) {
            data = JSON.parse(data);
            callback(null, data);
          }).on('error', function(err) {
            callback(err, null);
          })
          .exec();
    } else {
      elastic.search(site, qryObj)
          .on('data', function(data) {
            data = JSON.parse(data);
            callback(null, data);
          }).on('error', function(err) {
            callback(err, null);
          })
          .exec();
    }
  };

  // Handles search requests
  // Post data includes site, token, query,  page, and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // query is the query being performed, page is the page of search being returned
  // typeName is the type to restrict to, null for all types
  app.post('/search/', function(req, res) {
    var site = req.body.site;
    var token = req.body.token;
    var query = req.body.query;
    var page = req.body.page || 1;
    var typeName = req.body.typeName || null;

    cleanUpFiles(req);

    fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {
      if(active === false) {
        res.json(401, { error: 'Site not active, please check billing status.' });
        res.end();
        return;
      }

      fireUtil.get(firebaseRoot + '/management/sites/' + site + '/key', function(key) {
        if(key === token) {
          searchElastic(unescapeSite(site), query, page, typeName, function(err, data) {
            if(err) {
              res.json(500, { error: err });
            }
            if(!data.hits) {
              res.json(200, { 'hits' : {} });
            } else {
              res.json(200, { 'hits' : data.hits.hits });
            }
          });
        } else {
          res.json(401, {'error' : 'UNAUTHORIZED' });
        }
      });
    });
  });

  // Handles search indexing
  // Post data includes site, token, data, id, oneOff, and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // data is the data being indexed, id is the id of the object, oneOff is true/false depending 
  // on if the object is a oneOff, typeName is the type of the object
  app.post('/search/index/', function(req, res) {

    var site = req.body.site;
    var token = req.body.token;
    var data = req.body.data;
    var id   = req.body.id;
    var typeName = req.body.typeName;
    var oneOff = req.body.oneOff || false;

    cleanUpFiles(req);

    fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {
      if(active === false) {
        res.json(401, { error: 'Site not active, please check billing status.' });
        res.end();
        return;
      }

      fireUtil.get(firebaseRoot + '/management/sites/' + site + '/key', function(key) {
        if(key === token) {
          var parsed = JSON.parse(data);
          parsed.__oneOff = oneOff;

          elastic.index(unescapeSite(site), typeName, parsed, id).on('data', function(data) {
            if(data) {
              data = JSON.parse(data);
            }

            if(data.error) {
              res.json(500, { 'error' : data.error })
            } else {
              res.json(200, {'message' : 'success'});
            }
          }).exec();
        } else {
          res.json(401, {'error' : 'UNAUTHORIZED' });
        }
      });

    });
  });

  // Handles deleteting a search object
  // Post data includes site, token, id,  and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // id is the id of the object, typeName is the type of the object
  app.post('/search/delete/', function(req, res) {

    // Todo: validate this shit
    var site = req.body.site;
    var token = req.body.token;
    var id   = req.body.id;
    var typeName = req.body.typeName;

    cleanUpFiles(req);

    fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {
      if(active === false) {
        res.json(401, { error: 'Site not active, please check billing status.' });
        res.end();
        return;
      }

      fireUtil.get(firebaseRoot + '/management/sites/' + site + '/key', function(key) {
        if(key === token) {
          elastic.deleteDocument(unescapeSite(site), typeName, id).on('data', function(data) {
            res.json(200, {'message' : 'success'});
          }).exec();
        } else {
          res.json(401, {'error' : 'UNAUTHORIZED' });
        }
      });
    });
  });

  // Handles deleteting all objects of a type from search
  // Post data includes site, token, and typeName
  // Site and Token are the sitename and token for the site search is being performed on
  // typeName is the type of the object
  app.post('/search/delete/type/', function(req, res) {

    // Todo: validate this shit
    var site = req.body.site;
    var token = req.body.token;
    var typeName = req.body.typeName;

    cleanUpFiles(req);

    fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {
      if(active === false) {
        res.json(401, { error: 'Site not active, please check billing status.' });
        res.end();
        return;
      }

      fireUtil.get(firebaseRoot + '/management/sites/' + site + '/key', function(key) {
        if(key === token) {

          var qryObj = {
            "query" : {
              "match_all" : {}
            }
          };

          elastic.deleteMapping(unescapeSite(site), typeName).on('data', function(data) {
            res.json(200, {'message' : 'success'});
          }).exec();
        } else {
          res.json(401, {'error' : 'UNAUTHORIZED' });
        }
      });

    });
  });


  // Deletes an entire index (site) from search
  // Post data includes site and  token
  // Site and Token are the sitename and token for the site search is being performed on
  app.post('/search/delete/index/', function(req, res) {

    // Todo: validate this shit
    var site = req.body.site;
    var token = req.body.token;

    cleanUpFiles(req);

    fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {
      if(active === false) {
        res.json(401, { error: 'Site not active, please check billing status.' });
        res.end();
        return;
      }

      fireUtil.get(firebaseRoot + '/management/sites/' + site + '/key', function(key) {
        if(key === token) {

          elastic.deleteIndex(unescapeSite(site)).on('data', function(data) {
            res.json(200, {'message' : 'success'});
          }).exec();
        } else {
          res.json(401, {'error' : 'UNAUTHORIZED' });
        }
      });

    });
  });

  // Handles uploading a site to our system and triggering a build
  // Post data in cludes site, token, and the file called payload
  // Site and Token are the name of the site and the token for the site to upload to
  // The Payload file is the zip file containing the site generated by wh deploy
  app.post('/upload/', function(req, res) {

    var site = req.body.site;
    var token = req.body.token;
    var payload = req.files.payload; 

    if(!payload || !payload.path) {
      cleanUpFiles(req);
      res.status(500);
      res.end();
    }

    // Check active status of site and if the key is correct
    fireUtil.get(firebaseRoot + '/billing/sites/' + site + '/active', function(active) {
      if(active === false) {
        cleanUpFiles(req);
        res.json(500, { error: 'Site not active, please check billing status.' });
        res.end();
        return;
      }

      fireUtil.get(firebaseRoot + '/management/sites/' + site + '/key', function(data) {
        if(data === token)
        {
          // If key is good, repackage the zip files into a new zip and upload
          sendFiles(site, payload.path, function(err) {

            if(err) {
              cleanUpFiles(req);
              res.json(500, { error: err });
            } else {
              cleanUpFiles(req);
              res.json(200, { 'message': 'Finished' });
            }

          });
        } else {
          cleanUpFiles(req);
          res.json(401, {'error' : 'Invalid token'});
        } 

      });

    });

    function sendFiles(site, path, callback) {
      // When done zipping up, upload to our archive in cloud storage
      cloudStorage.objects.upload(config.get('sitesBucket'), path, site + '.zip', function(err, data) {
        fs.unlinkSync(path);
        // Signal build worker to build the site
        var ts = Date.now();
        fireUtil.set(firebaseRoot + '/management/sites/' + site + '/version', ts, function(){
          fireUtil.set(firebaseRoot + '/management/commands/build/' + site, { userid: 'admin', sitename: site, id: uniqueId() }, function(){
            callback();
          });
        });
      });
    }

  });

  app.listen(3000);
  console.log('listening on 3000...'.red);
};