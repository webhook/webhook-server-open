'use strict';

// Requires
var fs = require('fs');
var firebase = require('firebase');
var colors = require('colors');
var _ = require('lodash');
var uuid = require('node-uuid');
var winSpawn = require('win-spawn');
var wrench = require('wrench');
var async = require('async');
var mkdirp = require('mkdirp');
var cloudStorage = require('./cloudStorage.js');
var crypto = require('crypto');
var JobQueue = require('./jobQueue.js');
var touch = require('touch');
var domain = require('domain');

var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var unescapeSite = function(site) {
  return site.replace(/,1/g, '.');
}

/**
 * The main build worker. The way this works is that it first checks to
 * see if it has a local up-to-date copy of the site, if it doesn't then it
 * downloads them from the cloud storage archive. After downloading it simply
 * runs `grunt build` in the sites directory, then uploads the result to cloud storage.
 *
 * @param  {Object}   config     Configuration options from Grunt
 * @param  {Object}   logger     Object to use for logging, deprecated, not used
 */
module.exports.start = function (config, logger) {
  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  // This is a beanstalk based worker, so it uses JobQueue
  var jobQueue = JobQueue.init(config);

  var self = this;
  var firebaseUrl = config.get('firebase') || '';

  this.root = new firebase('https://' + firebaseUrl +  '.firebaseio.com/buckets');

  /*
  *  Reports the status to firebase, used to display messages in the CMS
  *
  *  @param site    The name of the site
  *  @param message The Message to send
  *  @param status  The status code to send (same as command line status codes)
  */
  var reportStatus = function(site, message, status) {
    var messagesRef = self.root.root().child('/management/sites/' + site + '/messages/');
    messagesRef.push({ message: message, timestamp: Date.now(), status: status, code: 'BUILD' }, function() {
      messagesRef.once('value', function(snap) {
        var size = _.size(snap.val());

        if(size > 50) {
          messagesRef.startAt().limit(1).once('child_added', function(snap) {
            snap.ref().remove();
          });
        }
      });
    });
  };

  /*
  * Downloads the site archive from cloud storage
  *
  * @param buildFolders The folder to write the archive to
  * @param site         Name of the site
  * @param callback     Callback to call when downloaded
  */
  var downloadSiteZip = function(buildFolders, site, callback) {
    cloudStorage.objects.get(config.get('sitesBucket'), site + '.zip', function(err, data) {
      if(fs.existsSync(buildFolders + '/' + site + '.zip')) {
        fs.unlinkSync(buildFolders + '/' + site + '.zip');
      }

      fs.writeFileSync(buildFolders + '/' + site + '.zip', data);

      callback();
    });
  }

  self.root.auth(config.get('firebaseSecret'), function(err) {
    if(err) {
      console.log(err.red);
      process.exit(1);
    }

    console.log('Waiting for commands'.red);

    // Wait for a build job, extract info from payload
    jobQueue.reserveJob('build', 'build', function(payload, identifier, data, client, callback) {
      var userid = data.userid;
      var site = data.sitename;
      var noDelay = data.noDelay || false;

      console.log('Processing Command For '.green + site.red);

      self.root.root().child('management/sites/' + site).once('value', function(siteData) {
        var siteValues = siteData.val();

        // If the site does not exist, may be stale build, should no longer happen
        if(!siteValues) {
          callback();
          return;
        }

        // Create build-folders if it isnt there
        mkdirp.sync('../build-folders/');

        var siteName = siteData.name();
        var buildFolder = '../build-folders/' + siteName;

        // Process the site, this is abstracted into a function so we can wrap it
        // in a Domain to catch exceptions
        function processSite(buildFolder) { 
          // Only admin or the site owners can trigger a build
          if(_(siteValues.owners).has(escapeUserId(userid)) || _(siteValues.users).has(escapeUserId(userid)) || userid === 'admin')
          {
            // If build time is defined, we build it now, then put in a job back to beanstalk with a delay
            // to build it later as well.
            var now = Date.now();
            var buildtime = data.build_time ? Date.parse(data.build_time) : now;
            var buildDiff = Math.floor((buildtime - now)/1000);

            // Build the site, strict will cause death if any error is thrown
            runInDir('grunt', buildFolder , ['build', '--strict=true'], function(err) {
              if(err) {
                // Dont upload failed builds, simply send error to CMS
                reportStatus(siteName, 'Failed to build, errors encountered in build process', 1);
                console.log('done with errors');
                callback();
              } else {

                // If there was a delay, push it back into beanstalk, then upload to the bucket
                if(buildDiff > 0 && !noDelay) {
                  var diff = data.build_time - now;

                  data['noDelay'] = true;

                  client.put(1, buildDiff, (60 * 3), JSON.stringify({ identifier: identifier, payload: data }), function() {
                    uploadToBucket(siteName, siteValues, buildFolder + '/.build', function() {
                      reportStatus(siteName, 'Built and uploaded.', 0);
                      console.log('done');
                      callback();
                    });
                  });
                } else {
                  // No delay, upload right away
                  uploadToBucket(siteName, siteValues, buildFolder + '/.build', function() {
                    reportStatus(siteName, 'Built and uploaded.', 0);
                    console.log('done');
                    callback();
                  });
                }
              }
            });
          } else {
            console.log('Site does not exist or no permissions');
            callback();
          }
        }

        // Run a domain so we can survive any errors
        var domainInstance = domain.create();

        domainInstance.on('error', function(err) { 
          console.log(err);
          reportStatus(siteName, 'Failed to build, errors encountered in build process', 1);
          callback();
        });

        domainInstance.run(function() {
          // Check if latest version of site, if not download and unzip latest version
          if(!fs.existsSync(buildFolder + '/.fb_version' + siteValues.version)) {

            console.log('Downloading zip');
            downloadSiteZip('../build-folders' , siteName, function() {

              var unzipStuff = function() {
                mkdirp.sync(buildFolder);

                runInDir('unzip', buildFolder, ['-q', '../' + site + '.zip'], function(err) {
                  fs.unlinkSync('../build-folders/' + site + '.zip');
                  touch.sync(buildFolder + '/.fb_version' + siteValues.version);

                  processSite(buildFolder);
                });
              };
              
              if(fs.existsSync(buildFolder)) {
                runInDir('rm', buildFolder + '/..', ['-rf', buildFolder], function(err) {
                  unzipStuff();
                });
              } else {
                unzipStuff();
              }

            })
          } else {
            processSite(buildFolder);
          }
        })


      }, function(err) {
        callback();
      });
    });

  });

  /*
  * Uploads site to the sites bucket, tries to not bother uploading things
  * that havent changed.
  *
  * @param siteName   Name of the site
  * @param siteValues Values for the site object in firebase
  * @param folder     Folder to upload from
  * @param callback   Callback to call when done
  */
  function uploadToBucket(siteName, siteValues, folder, callback) {

    if(!fs.existsSync(folder)) {
      callback({ error: 'No directory at ' + folder});
      return;
    }

    var files = wrench.readdirSyncRecursive(folder);
    var funcs = [];

    var deleteList = {};
    var md5List = {};

    var siteBucket = unescapeSite(siteName);

    // We list the objects in cloud storage to avoid uploading the same thing twice
    cloudStorage.objects.list(siteBucket, function(err, body) {

      if(err) {
        callback();
      }

      // Get a list of all objects already existing in cloud storage,
      // add its MD5 to a list. Also add it to a potential delete list
      // We will remove objects we upload from teh delete list as we upload them
      // If we dont add them, they've been removed so we need to delete them.
      if(body.items) {
        body.items.forEach(function(item) {
          if(item.name.indexOf('webhook-uploads/') !== 0) {
           deleteList[item.name] = true;
           md5List[item.name] = item.md5Hash;
          }
        });
      }

      // For each file to upload, check to see if the MD5 is the same as the one
      // currently in cloud storage, if so, dont bother uploading it again
      files.forEach(function(file) {
        var source = folder + '/' + file;

        if(!fs.lstatSync(source).isDirectory())
        {
          var ignore = false;
          // Check MD5 hash here, if its the same then dont even bother uploading.
          if(md5List[file]) {
            var newHash = crypto.createHash('md5').update(fs.readFileSync(source)).digest('base64');
            if(newHash === md5List[file]) {
              ignore = true; // File is the same, skip it
            }
          }

          if(!ignore) {       

            var cache = 'no-cache';
            if(file.indexOf('static/') === 0) {
             // cache = 'public,max-age=3600';
            }

            // upload function (will upload with gz compression)
            funcs.push( function(step) {
              cloudStorage.objects.uploadCompressed(siteBucket, source, file, cache, function(err, body) {
                step();
              });
            });

            // For everything thats not a static file and is an index.html file
            // upload a copy to the / file (/page/index.html goes to /page/) to deal
            // with cloud storage redirect b.s.
            if(file.indexOf('static/') !== 0 && file.indexOf('/index.html') !== -1) {
              funcs.push( function(step) {
                cloudStorage.objects.uploadCompressed(siteBucket, source, file.replace('/index.html', ''), cache, 'text/html', function(err, body) {
                  step();
                });
              });
            }
          }
        }

        // If we had it on the delete list, remove it from the delete list as we've uploaded it
        if(deleteList[file])
        {
          delete deleteList[file];
        }
      });

      // Delete the items left in the delete list. They must be items not in the current build
      _.forOwn(deleteList, function(num, key) {

        funcs.push( function(step) {
          cloudStorage.objects.del(siteBucket, key, function(err, body) {
            step();
          });
        });

      });

      // Run the uploads in parallel
      async.parallel(funcs, function() {

        cloudStorage.buckets.updateIndex(siteBucket, 'index.html', '404.html', function(err, body) {
          console.log('updated');
          callback();
        });
        
      });

    });

  }

};

/*
* Runs a command in a directory
*
* @param command  Command to run
* @param cwd      Working directory for command
* @param args     Arguments for command, in array form
* @param callback Callback to call when finished
*/
function runInDir(command, cwd, args, callback) {
  if(!fs.existsSync(cwd)) {
    callback({ 'error': 'No directory at ' + cwd });
    return;
  }

  var spawnedCommand = winSpawn(command, args, {
    stdio: 'inherit',
    cwd: cwd
  });

  spawnedCommand.on('close', function(exit, signal) {

    if(exit === 0) {
      callback(null);
    } else {
      callback(exit);
    }

  });
}