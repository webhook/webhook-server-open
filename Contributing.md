### What the server does

The Webhook Server runs several workers and web servers that are used in conjuction with the webhook-cms and webhook tools to generate static sites.

The workers handle things such as: Generating static sites on demand, uploading static sites to cloud storage, inviting users to work on sites, backing up data periodically, etc.

The web server handles things such as: Uploading images, searching using elastic search, and uploading sites to the workers.

### Contributing to this repo

We welcome contributions to this repo, but please be cognisant that this code runs on thousands of websites. Therefor we're pretty strict about what we accept.

Please consider the following before submitting your pull request:

1. Is the code backwards compatible with previous versions of the server?
2. Is the code documented, properly explained and follow the naming patterns of the current code?
3. Does it add generic abilities that are useful to most projects, not just your own?
4. You are contributing your code under the MIT license this code is provided with.

### Setting up a dev environment

Goes without saying you'll need to have Node, Grunt and Webhook installed to work on this repo.

You will also need a local daemon of Beanstalk and Memacached running if you wish to work on the workers.

In order to run the webhoook web server you can:

  1. Clone this repo somewhere locally.
  2. `cd webhook-server-open`
  3. Configure the Gruntfile.js appropriately
  4. Run `grunt startServer`.
  5. Then when using the `wh` commands simply supply the --server option with your local ip address

In order to run the webhook workers locally you will need to:
  1. Have beanstalkd running
  2. Have memcached  running
  3. Clone this repo somewhere locally
  4. `cd webhook-server-open`
  5. Configure the Gruntfile.js appropriately
  6. Run the command delagator `grunt commandDelegator`
  7. Run the worker you want  e.g. `grunt buildWorker`
  8. Then when using the `wh` commands simply supply the --server option with your local ip address

### Submitting Pull Requests

Please do the following when submitting a pull request:

1. Please create a corresponding issue for the pull request.
2. Please name the issue as either a feature addition or a bug fix.
3. Please reference an issues in your pull requests.

### Description of Files

Here is a description of the various files that are in the server repo, and what their purpose is:

[Gruntfile.js](https://github.com/webhook/webhook-server-open/blob/master/Gruntfile.js)

* The main gruntfile.
* Contains the configuration options for the self-hosting setup

[libs/backup.js](https://github.com/webhook/webhook-server-open/blob/master/libs/backup.js)

* Contains the cron job used to backup data from firebase
* Should be set to run at least once a day

[libs/backupExtractor.js](https://github.com/webhook/webhook-server-open/blob/master/libs/backupExtractor.js)

* Contains the utilities used to extract the backup of a specific site from the nightly backups

[libs/builder.js](https://github.com/webhook/webhook-server-open/blob/master/libs/builder.js)

* The main build worker, handles building sites when signaled and uploading them to cloud storage
* Downloads sites from google cloud storage, extracts local copies to a build folder

[libs/cloudStorage.js](https://github.com/webhook/webhook-server-open/blob/master/libs/cloudStorage.js)

* Main API Library for interacting with cloud storage through node.
* Used by almost every other worker/server, very important.

[libs/commandDelegator.js](https://github.com/webhook/webhook-server-open/blob/master/libs/commandDelegator.js)

* Handles delegating commands from firebase to beanstalk.
* Uses memcached to avoid duplicate jobs

[libs/creator.js](https://github.com/webhook/webhook-server-open/blob/master/libs/creator.js)

* Worker that creates and initializes new sites.
* Creates buckets in cloud storage, creates access key used to access buckets in firebase.

[libs/extractKey.js ](https://github.com/webhook/webhook-server-open/blob/master/libs/extractKey.js)

* Utility to extract google service account SSH key for self-hosting.

[libs/firebase-util.js](https://github.com/webhook/webhook-server-open/tree/master/libs/firebase-util.js)

* A library used to get/set data from firebase through HTTP rather than Websockets
* Useful for situations where a long running websocket is undesirable.

[libs/invite.js](https://github.com/webhook/webhook-server-open/tree/master/libs/invite.js)

* The invite worker, handles sending invite emails to users who have been invited to a site

[libs/jobQueue.js ](https://github.com/webhook/webhook-server-open/blob/master/libs/jobQueue.js)

* The jobQueue base file, used by all workers, handles reserving jobs from Beanstalk
* Uses memcached to lock jobs while processing

[libs/server.js ](https://github.com/webhook/webhook-server-open/blob/master/libs/server.js)

* The main webhook web server
* Handles uploading files from wh push to workers
* Handles uploading files/images from the CMS
* Handles search ruquests against elastic



