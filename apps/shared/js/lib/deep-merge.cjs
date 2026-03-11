// CJS wrapper for Electron/Windows main process
// Tests and browser use the ESM version (deep-merge.js) directly

function deepMerge(target, source, replaceKeys, _prefix) {
  if (!replaceKeys) replaceKeys = [];
  if (!_prefix) _prefix = '';
  var result = Object.assign({}, target);
  var keys = Object.keys(source);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var path = _prefix ? _prefix + '.' + key : key;
    if (replaceKeys.indexOf(path) !== -1) {
      result[key] = source[key];
    } else if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key], replaceKeys, path);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = { deepMerge };
