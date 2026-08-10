// Loading this module is completely clean: nothing is required at the top level,
// so packing it, installing it and importing it all succeed. The dependency only
// appears when someone actually calls prettyPrint() — which is to say, in
// production, on somebody else's machine.
'use strict';

exports.value = 42;

exports.prettyPrint = function prettyPrint(x) {
  const ghost = require('pp-fixture-ghost2');
  return ghost.format(x);
};

// require('pp-fixture-commented') must NOT be reported.
exports.lazyAsync = async function lazyAsync() {
  const mod = await import('node:util');
  return mod.format('%j', exports.value);
};
