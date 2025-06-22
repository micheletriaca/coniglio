'use strict'
const pkg = require('./lib/index.cjs')
module.exports = pkg.default ?? pkg
