var Transform = require('stream').Transform;

/*
* This is a utility used to extract the backup of a speciifc site from the main
* backup file. For effeciency reasons we only backup the entire firebase, we don't
* split it per site.
*
* This utility uses streams and JSON parsers to parse out only the part we need
* for a specific site.
*
* @params keyArray an array describing the top level key we want to extract. E.g.
*                  ['buckets', 'test', key, 'dev'], will extract buckets.test.key.dev
*/
module.exports.getParser = function(keyArray) {
  var parser = new Transform();
  var level = 0;
  var inBucketKey = false;
  var keyBuffer  = "";
  var capturingKey = false;
  var curMatchingKey = keyArray[0];
  var curMatchingLevel = 1;
  var finalMatch = false;
  var finalMatchLevel = -1;
  var stripFirst = true;

  var noMore = false;
  var ignoreNext = false;
  var ignoreCounter = 0;
  var inString = false;

  // Custom state machine to parse out the fields we need
  // Is called in chunks as stream is read
  parser._transform = function(data, encoding, done) {
    var str = data.toString();

    // We've finished running the statemachine exit
    if(noMore) {
      done();
      return;
    }

    // Used to store this current data
    var jsonData = "";
    for(var i = 0; i < str.length; i++) {
      // If we still need to parse stuff
      if(!noMore) { 
        // Used to ignore combinations we want to ignore 
        if(ignoreCounter == 1 && ignoreNext) {
          ignoreNext = false;
          ignoreCounter = 0;
        }

        ignoreCounter++;

        if(finalMatch) {
          jsonData += str.charAt(i);
        }

        // This tells us to ignore escaped items, we do this because
        // we really want to find the " and { used to encapsulate keys
        // Not ones that are part of values
        if(str.charAt(i) === '\\') {
          ignoreNext = true;
          ignoreCounter = 0;
        }

        // If were not supposed to ignore this, detect if we have a ", and if we are capturing
        // a key. If so it means were probably exiting a key name e.g. "adgadg" : { stuff.. }
        // So we need to capture the key name, and if it matches one in our keyArray we need
        // to increase the level (or if its not, we need to stop capturing).
        if(!ignoreNext && level === curMatchingLevel && str.charAt(i) === "\"" && capturingKey == true) {
          capturingKey = false;
          if(keyBuffer === curMatchingKey) {
            curMatchingLevel += 1;
            curMatchingKey = keyArray[curMatchingLevel - 1];

            if(curMatchingKey === undefined) {
              finalMatch = true;
              finalMatchLevel = level + 1;
            }
          }
          keyBuffer = "";
        }

        // If we reach a { (which is not in a string) Weve increase our level by 1
        if(!ignoreNext && !inString && str.charAt(i) === '{') {
          level += 1;
        }

        // If we need to be capturing a key (weve entered a key), capture it
        if(capturingKey) {
          keyBuffer += str.charAt(i);
        }

        // If we reach a } weve exited the current level. If we were matching 
        // the object (we reached the key we wanted to do) and we've exited
        // back to our starting depth, then we need to stop, we are done capturing
        if(!ignoreNext && !inString && str.charAt(i) === '}') {

          if(finalMatch && finalMatchLevel == level) {
            finalMatch = false;
            noMore = true;
          }

          level -= 1;
          keyBuffer = "";
        }

        // Let us know if we've entered or exited a string object
        // Used to let us know if } { are legit or inside a string
        if(!ignoreNext && str.charAt(i) === "\"") {
          inString = !inString;
        }

        // If we reach a " that is not escaped, and its on our current level of capturing, we are probably
        // entering a key, and should match the key so we can parse it later
        if(!ignoreNext && level === curMatchingLevel && str.charAt(i) === "\"" && capturingKey == false) {
          capturingKey = true;
        };
      }
    }

    // Some final adjustment to json data before we write it out
    if(jsonData) {
      if(stripFirst) {
        stripFirst = false;
        jsonData = jsonData.slice(1);
      }
      this.push(new Buffer(jsonData, 'utf8'));
    }
    done();
  };

  // Return the stream object to be used by the parent
  return parser;
};
