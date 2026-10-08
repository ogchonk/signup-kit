// Resend delivery events (Svix-signed): bounced or complaining addresses are marked unsubscribed.
module.exports = require('@ogchonk/signup-kit/node').createNewsletterWebhookHandler(require('../signup-config'))
