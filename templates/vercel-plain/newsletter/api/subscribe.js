// POST {{signupPath}}: the shared newsletter sign-up (double opt-in, @ogchonk/signup-kit), configured in ../signup-config.js.
module.exports = require('@ogchonk/signup-kit/node').createNewsletterHandler(require('../signup-config'))
