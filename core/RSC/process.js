// NOTE: child_process is intentionally NOT re-exported here.
// Exposing exec/spawn/execSync directly on the public server API is a critical
// security risk that would allow any consumer of @swavoti/vula/server to run
// arbitrary shell commands. Use child_process directly in your own server code if needed.
module.exports = {};
