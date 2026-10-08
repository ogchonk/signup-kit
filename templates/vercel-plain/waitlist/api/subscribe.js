// POST {{signupPath}}: the shared waitlist sign-up (@ogchonk/signup-kit), configured in ../signup-config.js.
module.exports = require('@ogchonk/signup-kit/node').createWaitlistHandler(require('../signup-config'))
