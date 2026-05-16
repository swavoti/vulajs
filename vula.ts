import { Command } from "https://deno.land/x/cliffy@v0.25.7/command/mod.ts";
import { existsSync, readFileSync } from "https://deno.land/std@0.177.0/node/fs.ts";

/**
 * Vula CLI: A tool to help you run and build your Vula.js project.
 * It works with both Deno and Node.
 */
export async function main() {
  // Load configuration from package.json
  let config = { runtime: "deno" };
  if (existsSync("./package.json")) {
    const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
    if (pkg.runtime === "node") {
      config.runtime = "node";
    }
  }

  await new Command()
    .name("vula")
    .version("1.0.0")
    .description(`Vula.js CLI (Running on ${config.runtime.toUpperCase()})`)
    
    .command("dev", "Start development server with HMR and file-based routing")
    .action(async () => {
      console.log(`%c Vula.js %c Launching dev server on ${config.runtime}...`, "background: #764ba2; color: white; padding: 2px 4px; border-radius: 4px;", "");
      
      if (config.runtime === "deno") {
        const cmd = new Deno.Command("deno", {
          args: ["run", "-A", "npm:@rspack/cli", "serve", "--config", "rspack.config.js"],
        });
        const child = cmd.spawn();
        await child.status;
      } else {
        // Node compatibility logic (using simple spawn)
        console.log("Switching to Node.js runtime...");
        const process = Deno.run({
          cmd: ["npx", "rspack", "serve", "--config", "rspack.config.js"],
          stdout: "inherit",
          stderr: "inherit",
        });
        await process.status();
      }
    })

    .command("build", "Build for production")
    .action(async () => {
      console.log(`%c Vula.js %c Building for production on ${config.runtime}...`, "background: #764ba2; color: white; padding: 2px 4px; border-radius: 4px;", "");
      
      const args = config.runtime === "deno" 
        ? ["run", "-A", "npm:@rspack/cli", "build"] 
        : ["npx", "rspack", "build"];
      
      const process = Deno.run({
        cmd: [config.runtime === "deno" ? "deno" : "npx", ...args.filter(a => a !== "npx")],
        stdout: "inherit",
        stderr: "inherit",
      });
      await process.status();
    })

    .parse(Deno.args);
}

if (import.meta.main) {
  main();
}
