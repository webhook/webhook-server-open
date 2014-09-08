/**
* The backup worker is meant to run as a cron job that runs periodically.
* It downloads the full JSON data from the firebase that contains all the sites
* then uploads it to the backup bucket in google cloud storage. This way we
* have a full backup of all the sites/information/users that we can restore
* if we need to
*/

var request = require('request');
var cloudStorage = require('./cloudStorage.js');
var firebase = require('firebase');
var _ = require('lodash');


/**
* @params config The configuration from Grunt
* @params logger Logger to use, deprecated, does not actually get used at all
*/
module.exports.start = function (config, logger) {

  // Necessary setup for cloud storage module
  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  var backupTs = Date.now();
  var self = this;

  var firebaseUrl = config.get('firebase') || '';
  this.root = new firebase('https://' + firebaseUrl +  '.firebaseio.com');

  // Auth against firebase
  self.root.auth(config.get('firebaseSecret'), function(err) {
    // We force ourself to get the token first, because we will use it to bypass
    // our cloud storage module, this request is very special so we build it manually
    cloudStorage.getToken(function(token) {
      // This is the upload reuqest, because the file can be so large we use the resumable
      // upload API of cloud storage. So first we request a url to upload to.
      request({
        url: 'https://www.googleapis.com/upload/storage/v1/b/' + config.get('backupBucket') + '/o',
        qs: { uploadType: 'resumable', 'access_token' : token },
        method: 'POST',
        headers: {
          'X-Upload-Content-Type' : 'application/json',
          'Content-Type' : 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          name: 'backup-' + backupTs,
          cacheControl: "no-cache"
        }) 
      }, function(err, res, body) {
        var url = res.headers.location;

        // The location returned by google is the url to send the file to for upload
        // We create a get request to download the data from firebase and pipe it into
        // a PUT request to googles cloud url, for effeciency.
        request.get('https://' + config.get('firebase') + '.firebaseio.com/.json?auth=' + config.get('firebaseSecret') + '&format=export').pipe(
          request.put(url, function(err, res, body) {
            // We update the list of backups in firebase
            self.root.child('management/backups/').push(backupTs, function() {
              // Do cleanup of old backups here, delete ones past 7 days ago
              self.root.child('management/backups/').once('value', function(snap) {
                var data = snap.val();

                var ids = _.keys(data);

                if(ids.length > 7) {
                  var oldestId = ids[0];
                  var oldestTimestamp = data[oldestId];

                  self.root.child('management/backups/' + oldestId).remove(function() {
                    cloudStorage.objects.del(config.get('backupBucket'), 'backup-' + oldestTimestamp, function() {
                      console.log('Done');
                      process.exit(0);
                    });
                  });
                } else {
                  console.log('Done');
                  process.exit(0);
                }
              });
            });
          })
        );
      });
    });

  });
};

