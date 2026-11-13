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
  const streamSurfaces = [];
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
        let routePath = "/" + relative(appDir, dir).replace(/\\/g, "/");
        if (routePath === "/.") {
          routePath = "/";
        } else {
          // Convert [param] to :param
          routePath = routePath
            .replace(/\[\.\.\.([^\]]+)\]/g, "*$1")
            .replace(/\[([^\]]+)\]/g, ":$1");
        }
        routes.push({
          path: routePath,
          componentPath: fullPath,
          clientPath: relative(appDir, fullPath).replace(/\\/g, "/"),
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

      // Stream surfaces: *.stream.ts / *.stream.js / *.stream.comp.ts / *.stream.comp.js
      if (
        file.endsWith(".stream.ts") ||
        file.endsWith(".stream.js") ||
        file.endsWith(".stream.comp.ts") ||
        file.endsWith(".stream.comp.js")
      ) {
        const relativeDir = relative(appDir, dir).replace(/\\/g, "/");
        const name = file.replace(/\.stream(?:\.comp)?\.(ts|js)$/, "");
        streamSurfaces.push({
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
        // Convert [param] to :param
        apiPath = apiPath.replace(/\[([^\]]+)\]/g, ":$1");

        apiRoutes.push({
          path: apiPath,
          handlerPath: fullPath,
        });
        continue;
      }
    }
  }

  scan(appDir);
  routes.sort((left, right) => {
    const leftSegments = left.path.split("/").filter(Boolean);
    const rightSegments = right.path.split("/").filter(Boolean);
    for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index += 1) {
      const leftKind = leftSegments[index].startsWith("*") ? 2 : leftSegments[index].startsWith(":") ? 1 : 0;
      const rightKind = rightSegments[index].startsWith("*") ? 2 : rightSegments[index].startsWith(":") ? 1 : 0;
      if (leftKind !== rightKind) return leftKind - rightKind;
    }
    return rightSegments.length - leftSegments.length;
  });
  return { routes, apiRoutes, serverComponents, streamSurfaces, middleware };
}

function generateClientRouteManifest(manifest) {
  return {
    routes: manifest.routes.map(({ path, clientPath }) => ({ path, clientPath })),
  };
}

module.exports = { generateClientRouteManifest, generateRouteManifest };
