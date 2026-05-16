const { readdirSync, lstatSync, existsSync } = require("fs");
const { join, relative } = require("path");

/**
 * Scans the app/ directory and builds a route manifest
 * for pages, API handlers, server components, and middleware.
 */
function generateRouteManifest(appDir) {
  const routes = [];
  const apiRoutes = [];
  const serverComponents = [];
  let middleware = null;

  function scan(dir) {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir);

    for (const file of files) {
      const fullPath = join(dir, file);
      const stat = lstatSync(fullPath);

      if (stat.isDirectory()) {
        scan(fullPath);
        continue;
      }

      // Page routes: app/**/page.tsx or page.jsx
      if (file === "page.tsx" || file === "page.jsx") {
        const routePath = "/" + relative(appDir, dir).replace(/\\/g, "/");
        routes.push({
          path: routePath === "/." ? "/" : routePath,
          componentPath: fullPath,
        });
        continue;
      }

      // Root middleware: app/middleware.ts
      if ((file === "middleware.ts" || file === "middleware.js") && dir === appDir) {
        middleware = fullPath;
        continue;
      }

      // Server components: *.sever.comp.ts
      if (file.endsWith(".sever.comp.ts") || file.endsWith(".sever.comp.js")) {
        const relativeDir = relative(appDir, dir).replace(/\\/g, "/");
        const name = file.replace(/\.sever\.comp\.(ts|js)$/, "");
        serverComponents.push({
          name: relativeDir ? `${relativeDir}/${name}` : name,
          path: fullPath,
        });
        continue;
      }

      // API routes: any .ts/.js file inside app/api/
      const apiDir = join(appDir, "api");
      if (dir.startsWith(apiDir) && (file.endsWith(".ts") || file.endsWith(".js"))) {
        const relativeTail = relative(apiDir, dir).replace(/\\/g, "/");
        const routeName = file.replace(/\.(ts|js)$/, "");
        let apiPath;
        if (relativeTail === ".") {
          apiPath = `/api/${routeName}`;
        } else {
          apiPath = `/api/${relativeTail}/${routeName}`;
        }
        // /api/users/index -> /api/users
        apiPath = apiPath.replace(/\/index$/, "") || "/api";

        apiRoutes.push({
          path: apiPath,
          handlerPath: fullPath,
        });
        continue;
      }
    }
  }

  scan(appDir);
  return { routes, apiRoutes, serverComponents, middleware };
}

module.exports = { generateRouteManifest };
