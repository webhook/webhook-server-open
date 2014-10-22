'use strict';

/**
* This is the main API used for interacting with Google Cloud Storage. It is used to manipulate
* the buckets and objects for the sites we host.
*/

var request = require('request');
var GAPI = require('gapitoken');
var mime = require('mime');
var fs   = require('fs');
var zlib = require('zlib');

var oauthToken = '';
var projectName = '';

var googleServiceAccount = '';

// Contains google service accounts SSH key
var keyFile = 'libs/keyfile.key';

/* 
* Refreshes the token used to access google cloud storage
*
* @param callback Callback to call when refreshed
*/
var refreshToken = function(callback) {
  var gapi = new GAPI({
      iss: googleServiceAccount,
      scope: 'https://www.googleapis.com/auth/devstorage.full_control https://www.googleapis.com/auth/siteverification',
      keyFile: keyFile
  }, function(err) {
     if (err) { console.log(err); process.exit(1); }

     gapi.getToken(function(err, token) {
        if (err) { return console.log(err); }
        oauthToken = token;

        callback();
     });     
  });
};

/*
* Run a json request against google cloud stoage, handles getting token
*
* @param options  Object of options to pass to the json request, mostly same options passed to request module
* @param callback Callback to call when finished
*/
function jsonRequest(options, callback)  {

  if(!options.qs)
  {
    options.qs = {};
  }

  options.qs.access_token = oauthToken;

  var multiData = [];

  if(options.multipart)
  {
    var index = 0;
    options.multipart.forEach(function(multi) {
      multiData.push({ index: index, body: multi.body});
      index = index + 1;
    });
  }
  
  var reqOptions = {
    url: options.url,
    qs: options.qs || null,
    method: options.method,
    json: options.multipart ? null : (options.data || true),
    headers: options.headers || null,
    multipart: options.multipart || null,
  };

  if(options.binary) {
    reqOptions['encoding'] = null;
  }

  // If the request wants to have a stream back ignore token, the caller is
  // responsible for making sure a token is active
  if(options.stream) {
    return request(reqOptions);
  } else {
    request(reqOptions, 
    function(err, res, body){
      if(err) {
        callback(err, null);
      } else if (!res) {
        callback(500, null);
      } else if(res.statusCode/100 === 2) {
        callback(null, body);
      } else if(res.statusCode === 401) {
        refreshToken(function() {
          if(options.multipart)
          {
            multiData.forEach(function(item) {
              options.multipart[item.index].body = item.body;
            });
          }

          jsonRequest(options, callback);
        });
      } else {
        callback(res.statusCode, null);
      }
   });
  }
}

// Sets the google project name we authenticate against
module.exports.setProjectName = function(project) {
  projectName = project;
}

// Sets the google service account email with authenticate with
module.exports.setServiceAccount = function(account) {
  googleServiceAccount = account;
}

// Manually get token, used when wanting a stream back, caller is
// responsible for making sure token is valid
module.exports.getToken = function(callback) {
  refreshToken(function() {
    callback(oauthToken);
  });
};

// Init, manually refreshes the token before we do any requests
// just to get things started
module.exports.init = function(callback) {
  refreshToken(function() {
    callback();
  });
}

// Sets the key file file, not curretly used
module.exports.setKeyFile = function(file) {
  keyFile = file;
}

// This object contains all methods that have to do with manipulating
// buckets
module.exports.buckets = {
  // Get a bucket's meta data from google cloud storage
  get: function(bucketName, callback) {

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucketName,
      method: 'GET'
    }, callback);
  },

  // List all buckets in the project
  list: function(callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b',
      qs: {
        'project' : projectName
      },
      method: 'GET',
    }, callback)
  },

  // Create a new bucket, makes the bucket a website hosting bucket
  create: function(bucketName, callback) {

    var data = {
      name: bucketName,
      website: {
        mainPageSuffix: 'index.html',
        notFoundPage: '404.html'
      }
    };

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/',
      qs: { project: projectName },
      data: data,
      method: 'POST'
    }, callback);
  },

  // Changes the ACLs on the bucket to allow the service account write access
  // and allow the public read access
  updateAcls: function(bucketName, callback) {
    var data = {
      entity: 'allUsers',
      role: 'READER'
    };

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucketName + '/defaultObjectAcl',
      data: data,
      method: 'POST',
    }, function() {

      data = {
        entity: 'user-' + projectName + '@appspot.gserviceaccount.com',
        role:   'OWNER',
      }

      jsonRequest({
        url: 'https://www.googleapis.com/storage/v1/b/' + bucketName + '/defaultObjectAcl',
        data: data,
        method: 'POST',
      }, callback);

    });
  },

  // Updates the website index on the bucket, unused
  updateIndex: function(bucketName, indexFile, notFoundFile, callback) {

    var data = {
      website: {
        mainPageSuffix: indexFile,
        notFoundPage: notFoundFile
      }
    };

    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucketName,
      data: data,
      method: 'PATCH'
    }, callback);
  },

  // Deletes an empty bucket from cloud storage
  del: function(bucketName, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucketName,
      method: 'DELETE'
    }, callback);
  }

};

// A collection of all functions related to manipulating objects in cloud storage
module.exports.objects = { 

  // List all objects in a bucket (name, md5hash)
  list: function(bucket, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o',
      qs: { fields: 'kind,items(name,md5Hash)', delimiter: 'webhook-uploads/' }
    }, callback);
  },

  // List all objects with more information (md5hash, updated time)
  listMore: function(bucket, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o',
      qs: { fields: 'kind,items(name,md5Hash,updated)', delimiter: 'webhook-uploads/' }
    }, callback);
  },

  // Get an object from a bucket, return stream for caller to manipulate
  getStream: function(bucket, file) {
    return jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o/' + file,
      qs: { alt: 'media' },
      binary: true,
      stream: true
    });
  },

  // Get an object from a bucket
  get: function(bucket, file, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o/' + file,
      qs: { alt: 'media' },
      binary: true
    }, callback);
  },

  /*
  * Upload file to bucket
  *
  * @param bucket           Bucket to upload to
  * @param local            Local file name
  * @param remote           Remote file name
  * @param cacheControl     Cache control header to put on object (optional)
  * @param overrideMimeType Mime type to use instead of auto detecting (optional)
  * @param callback         Callback with object
  *
  */
  upload: function(bucket, local, remote, cacheControl, overrideMimeType, callback) {
    if(typeof cacheControl === 'function') {
      callback = cacheControl;
      cacheControl = null;
      overrideMimeType = null;
    }

    if(typeof overrideMimeType === 'function') {
      callback = overrideMimeType;
      overrideMimeType = null;
    }

    jsonRequest({
      url: 'https://www.googleapis.com/upload/storage/v1/b/' + bucket + '/o',
      qs: { uploadType: 'multipart' },
      headers: {
        'content-type' : 'multipart/form-data'
      },
      method: 'POST',
      multipart: [{
          'Content-Type' : 'application/json; charset=UTF-8',
          body: JSON.stringify({
            name: remote,
            cacheControl: cacheControl ? cacheControl : "no-cache"
          })                  
      },{ 
          'Content-Type' : overrideMimeType ? overrideMimeType : mime.lookup(local),
          body: fs.readFileSync(local)
      }]
    }, callback);
  },

  /*
  * Upload file to bucket with gz compression
  *
  * @param bucket           Bucket to upload to
  * @param local            Local file name
  * @param remote           Remote file name
  * @param cacheControl     Cache control header to put on object (optional)
  * @param overrideMimeType Mime type to use instead of auto detecting (optional)
  * @param callback         Callback with object
  *
  */
  uploadCompressed: function(bucket, local, remote, cacheControl, overrideMimeType, callback) {
    if(typeof cacheControl === 'function') {
      callback = cacheControl;
      cacheControl = null;
      overrideMimeType = null;
    }

    if(typeof overrideMimeType === 'function') {
      callback = overrideMimeType;
      overrideMimeType = null;
    }

    var fileContent = fs.readFileSync(local);

    var now = Date.now();
    zlib.gzip(fileContent, function(err, content) {
      jsonRequest({
        url: 'https://www.googleapis.com/upload/storage/v1/b/' + bucket + '/o',
        qs: { uploadType: 'multipart' },
        headers: {
          'content-type' : 'multipart/form-data'
        },
        method: 'POST',
        multipart: [{
            'Content-Type' : 'application/json; charset=UTF-8',
            body: JSON.stringify({
              name: remote,
              cacheControl: cacheControl ? cacheControl : "no-cache",
              contentEncoding: 'gzip',
            })                  
        },{ 
            'Content-Type' : overrideMimeType ? overrideMimeType : mime.lookup(local),
            body: content
        }]
      }, callback);
    });

  },

  // Delete an object from bucket
  del: function(bucket, filename, callback) {
    jsonRequest({
      url: 'https://www.googleapis.com/storage/v1/b/' + bucket + '/o/' + encodeURIComponent(filename),
      method: 'DELETE'
    }, callback);
  }

};
