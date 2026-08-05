// Load native addon; nếu build/load fail thì export stub kèm LÝ DO (available:false).
let addon
try {
  addon = require('./build/Release/djspout.node')
} catch (e) {
  const reason = 'addon không nạp được: ' + (e && e.message ? e.message : String(e))
  addon = {
    open: () => false,
    sendHandle: () => false,
    sendImage: () => false,
    close: () => {},
    available: () => false,
    lastError: () => reason,
    adapterOf: () => -1
  }
}
module.exports = addon
