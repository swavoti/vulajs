const { execSync } = require('child_process');

function checkDenoSecurity() {
  try {
    // Attempt to get Deno version
    const output = execSync('deno --version', { stdio: 'pipe' }).toString();
    const match = output.match(/deno (\d+\.\d+\.\d+)/);
    
    if (match && match[1]) {
      const version = match[1];
      const parts = version.split('.').map(Number);
      
      // Known vulnerable Deno versions check
      // For example, anything below 1.40 is considered outdated in this context.
      const isOutdated = parts[0] < 1 || (parts[0] === 1 && parts[1] < 40);
      
      if (isOutdated) {
        console.error('\x1b[31m============================================================\x1b[0m');
        console.error('\x1b[31m[VULA SECURITY ALERT] OUTDATED DENO VERSION DETECTED\x1b[0m');
        console.error('\x1b[31m============================================================\x1b[0m');
        console.error(`\x1b[33mYou are currently running Deno version: ${version}\x1b[0m`);
        console.error('\x1b[31mThis Deno version is OUTDATED and has several known SECURITY VULNERABILITIES.\x1b[0m');
        console.error('Known risks include sandbox bypasses and network layer flaws.');
        console.error('For your safety and the security of your users, Vula CLI execution has been ABORTED.');
        console.error('');
        console.error('\x1b[36mPlease upgrade Deno immediately to the latest version.\x1b[0m');
        console.error('\x1b[36mFor update instructions and release notes, visit:\x1b[0m');
        console.error('\x1b[34m- https://deno.com/\x1b[0m');
        console.error('\x1b[34m- https://github.com/denoland/deno/security/advisories\x1b[0m');
        console.error('\x1b[31m============================================================\x1b[0m');
        process.exit(1);
      }
    }
  } catch (err) {
    // Deno is not installed or error getting version, which is fine if they use Node
  }
}

module.exports = { checkDenoSecurity };
