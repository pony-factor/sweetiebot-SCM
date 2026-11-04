'use strict';

// Windows loaded before the filename migration can request this path until
// their extension host reloads. Share the canonical module and its draft state.
module.exports = require('./commit-drafts');
