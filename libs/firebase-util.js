/*
* This module is a set of utilities to access firebase through HTTP
*
* This is used in modules where having long running https/websocket sessions with
* the normal firebase module is undesirable.
* 
* The only two operations supported are getting the value of a node, and setting it
*/
var request = require('request');

var authToken = '';
var config = {};

// Configure the firebase utility module, the only
// supported config option as of now is the secret key
module.exports.configUtils = function(conf) {
  config = conf;
  authToken = conf.get('firebaseSecret');
};

// Set the firebase secret key
module.exports.setToken = function(token) {
  authToken = token;
};

/*
* Get a value from firebase
*
* @param url      The firebase url to get the value from
* @param callback The callback to call with the firebase data
*/
module.exports.get = function(url, callback) {
  var self = this;

  var data = {};

  if(authToken !== '') {
    data.auth = authToken;
  }

  var parts = url.split('/');

  for(var i = 3; i < parts.length; i++) {
    parts[i] = encodeURIComponent(parts[i]);
  }

  url = parts.join('/');
  
  request(url + '.json', { qs: data, json: true }, function(err, res, body) {

    if(res.statusCode === 401)
    {
      self.authenticateFirebase(function() {
        self.get(url, callback);
      });
    } else {
      callback(body);
    }
  });
};

/*
* Set the firebase node at url with the data provided
*
* @param url      The firebase url to set data at
* @param payload  The data to set at the firebase url
* @param callback The callback to call once set
*/
module.exports.set = function(url, payload, callback) {
  var self = this;

  var data = {};

  if(authToken !== '') {
    data.auth = authToken;
  }

  var parts = url.split('/');

  for(var i = 3; i < parts.length; i++) {
    parts[i] = encodeURIComponent(parts[i]);
  }

  url = parts.join('/');

  request.put(url + '.json', { qs: data, body: JSON.stringify(payload), json: true }, function(err, res, body) {

    if(res.statusCode === 401)
    {
      self.authenticateFirebase(function() {
        self.get(url, callback);
      });
    } else {
      callback(body);
    }
  });

};
