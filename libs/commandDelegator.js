'use strict';

/**
* The command delegator is a program that moves jobs queued up in firebase into beanstalk. We move
* them to beanstalk because beanstalk is better at handling delayed jobs and making sure only one
* worker is executing a specific job. The delegator uses memcached to make sure it does not accidentally
* queue up multiple copies of the same job.
*/

var firebase = require('firebase');
var colors = require('colors');
var _ = require('lodash');
var async = require('async');
var beanstalkd = require('./node-beanstalkd.js');
var cloudStorage = require('./cloudStorage.js');
var Memcached = require('memcached');

var escapeUserId = function(userid) {
  return userid.replace(/\./g, ',1');
};

var handlingCommand = 0;
var dieSoon = false;

// Handle SIGTERM gracefully exit when command done processing
// useful for easy supervisor restart without losing data
process.on('SIGTERM', function() {

  if(handlingCommand === 0) {
    process.exit(0);
  } else {
    dieSoon = true;
  }

});

/**
 * @param  {Object}   config     Configuration options from .firebase.conf
 * @param  {Object}   logger     Object to use for logging, defaults to no-ops (DEPRECATED)
 */
module.exports.start = function (config, logger) {
  cloudStorage.setProjectName(config.get('googleProjectId'));
  cloudStorage.setServiceAccount(config.get('googleServiceAccount'));

  // Memcached is used for locks, to avoid setting the same job
  var memcached = new Memcached(config.get('memcachedServers'));
  var self = this;
  var firebaseUrl = config.get('firebase') || '';
  this.root = new firebase('https://' + firebaseUrl +  '.firebaseio.com/');

  // Where in firebase we look for commands, plus the name of the locks we use in memcached
  var commandUrls = [
    { commands: 'management/commands/build/', lock: 'build', tube: 'build' },
    { commands: 'management/commands/create/', lock: 'create', tube: 'create' },
    { commands: 'management/commands/verification/', lock: 'verification', tube: 'verification' },
    { commands: 'management/commands/invite/', lock: 'invite', tube: 'invite' },
    { commands: 'management/commands/dns/', lock: 'dns', tube: 'dns' },
  ];

  self.root.auth(config.get('firebaseSecret'), function(err) {
    if(err) {
      console.log(err.red);
      process.exit(1);
    }

    // For each command we listen on a seperate tube and firebase url
    console.log('Starting clients'.red);
    commandUrls.forEach(function(item) {

      // Seperate client per command
      var client = new beanstalkd.Client();
      client.connect(config.get('beanstalkServer'), function(err, conn) {
        if(err) {
          console.log(err);
          process.exit(1);
        }
        conn.use(item.tube, function(err, tubename) {
          if(err) {
            console.log(err);
            process.exit(1);
          }
          handleCommands(conn, item);
        });
      });
      
      client.on('close', function(err) {
        console.log('Closed connection');
        process.exit(1);
      });
    });
  });

  /*
  * Queues the command in beanstalk/firebase
  *
  * @param client     The beanstalk client
  * @param item       The item containing tube/lock information
  * @param identifier Unique identifer for the command
  * @param lockId     Lock to use
  * @param payload    Payload of the command to queue up
  * @param callback   Called when finished
  */
  function queueCommand(client, item, identifier, lockId, payload, callback) {
    console.log('Queueing Command for ' + item.tube);

    // Identifier is a uuid for the given command, so we lock it and just let it expire in an hour
    memcached.add(item.lock + '_' + lockId + '_queued', 'locked', 60 * 60, function(err) {
      if(err) {
        return;
      } else {
        // We give it a TTL of 3 minutes
        client.put(1, 0, (60 * 3), JSON.stringify({ identifier: identifier, payload: payload }), function() { callback(); });
      }
    });

  };

  // After creating a client we listen in firebase for jobs,
  // as jobs are added we queue them up ten listen again.
  function handleCommands(client, item) { 
    console.log('Waiting on commands for ' + item.tube);
    self.root.child(item.commands).on('child_added', function(commandData) {

      handlingCommand = handlingCommand + 1;

      var payload = commandData.val();
      var identifier = commandData.name();
      var lockId = payload.id || 'noneya';

      // We remove the data immediately to avoid duplicates
      commandData.ref().remove();
      
      queueCommand(client, item, identifier, lockId, payload, function() {
        handlingCommand = handlingCommand - 1;
        // If we had a sigterm and no one is handling commands, die
        if(dieSoon && (handlingCommand === 0)) {
          process.exit(0);
        }
      });

    }, function(err) {
      console.log(err);
    });
  }

  return this;
};