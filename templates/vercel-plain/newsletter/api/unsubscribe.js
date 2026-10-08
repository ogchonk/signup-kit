// GET shows the unsubscribe page (changes nothing); POST unsubscribes, including RFC 8058 one-click.
module.exports = require('@ogchonk/signup-kit/node').createNewsletterUnsubscribeHandler(require('../signup-config'))
