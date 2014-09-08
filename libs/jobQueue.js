'use strict';

/**
* The job queue is the base on which all the other workers are based off of. It handles reserving the jobs
* for a given worker from beanstalk, locking the jobs down while processing, and releasing the jobs when done.
* The job queue is run by each worker internally on their own tubes.
*/

var colors = require('colors');
var beanstalkd = require('./node-beanstalkd.js');
var Memcached = require('memcached');
var async = require('async');
var domain = require('domain');

module.exports.init = function (config) {

  // We use memcached to maintain some simple locks
  var memcached = new Memcached(config.get('memcachedServers'));

  var self = this;
  var processing = false;
  var dieSoon = false;

  // Custom terminator handler for supervisorctl
  // Allows one to restart an instance without intrupting processing
  process.on('SIGTERM', function() {
    if(!processing) {
      process.exit(0);
    } else {
      dieSoon = true;
    }
  });

  /*
  * Reserves jobs on the given tube 
  * 
  * @param tube      The tube to listen for jobs on
  * @param lockRoot  A unique identifer to lock jobs on
  * @param cb        Callback to call with reserved job data
  */
  self.reserveJob = function(tube, lockRoot, cb) {
    var client = new beanstalkd.Client();

    // Connect to beanstalk
    client.connect(config.get('beanstalkServer'), function(err, conn) {
      if(err) {
        console.log('Error: ' + err);
        process.exit(1);
      }

      // Both use and watch the tube, so that we can re-insert jobs
      conn.use(tube, function(err, tubename) {
        conn.watch(tube, function(err, tubename) {
          if(err) {
            console.log(err);
            process.exit(1);
          }

          // This is a standard reserve loop for beanstalk, we run an infinite loop
          // with a reserve call in the middle. The call blocks until the callback
          // is done processing.
          async.whilst(function() {return true; }, function(done) {
            conn.reserve(function(err, id, payload) {
              processing = true;
              console.log('Reserved job ' + id);
              if(err) {
                console.log(err);
                return;
              }

              payload = JSON.parse(payload);
              var identifier = payload.identifier;
              var data = payload.payload;

              // First we destroy the job in Beanstalk, then acquire the lock for it
              // Finally we run the callback (inside a domain to handle errors), and unlock the job after
              conn.destroy(id, function() {
                self.lockJob(conn, lockRoot, identifier, payload, function(payload, callback) {
                  var domainInstance = domain.create();

                  domainInstance.on('error', function(err) {
                    console.log('Caught exception: ' + err);
                    callback(function() {
                      process.exit(1);
                    });
                  });

                  domainInstance.run(function() {
                    cb(payload, identifier, data, conn, function() { 
                      console.log('Done job'); 
                      callback(function() { 
                        processing = false;

                        // Someone signaled for us to die while processing, die after being done
                        if(dieSoon) {
                          process.exit(0);
                        } 
                        done(); 
                      }); 
                    });
                  });
                }, done);
              });

            });
          });
        }); 
      });
    })

    client.on('close', function(err) {
        console.log('Closed connection');
        process.exit(1);
    });
  };

  /*
  * Unlocks a job on the given lock
  *
  * @param client The beanstalk client
  * @param lock   The lock ID to unlock
  * @param identifier An identifier for the job, from the payload
  * @param payload    The payload from beanstalk
  * @param callback   The callback to call when unlocked
  */
  self.unlockJob = function(client, lock, identifier, payload, callback) {
    // Make sure identifier is legal memcached string I guess
    memcached.del(lock + '_' + identifier + '_processing', function(err) {
      if (callback) callback();
    });
  };

  /*
  *  Locks the job in memcached
  *
  * @param client The beanstalk client
  * @param lock   The lock ID to lock
  * @param identifier An identifier for the job, from the payload
  * @param payload    The payload from beanstalk
  * @param callback   Function to call after lock succeeds, is passed payload and a final callback to call after processing
  * @param complete   Function to call after unlock succeeds
  */
  self.lockJob = function(client, lock, identifier, payload, callback, complete) {
    memcached.add(lock + '_' + identifier + '_processing', 1, 60 * 3, function(err) {
      if(err) {
        console.log('Delayed');
        client.put(1, 30, (60 * 3), JSON.stringify({ identifier: identifier, payload: payload.payload }), function() { complete(); });
      } else {
        callback(payload, function(done) { self.unlockJob(client, lock, identifier, payload, function() { done(); }); });
      }
    })
  };

  return self;
};
