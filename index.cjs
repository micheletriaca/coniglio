'use strict'
const pkg = require('./lib/index.cjs')
const coniglio = pkg.default ?? pkg
Object.assign(coniglio, pkg)
module.exports = coniglio
