// scripts/apply-package-tweaks.js
const fs = require("fs");
const path = require("path");

const pkgPath = path.resolve(process.cwd(), "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

function ensure(obj, key, fallback) {
  if (!obj[key]) obj[key] = fallback;
}

ensure(pkg, "scripts", {});
ensure(pkg, "devDependencies", {});
ensure(pkg, "lint-staged", {});

// scripts
pkg.scripts.prepare = "husky";
pkg.scripts.format = pkg.scripts.format || "prettier --write .";
pkg.scripts.lint =
  pkg.scripts.lint || "eslint . --ext .js,.mjs --max-warnings=0";

// devDependencies (keep versions flexible; installs already done are fine)
pkg.devDependencies.prettier = pkg.devDependencies.prettier || "^3";
pkg.devDependencies["lint-staged"] =
  pkg.devDependencies["lint-staged"] || "^16";
pkg.devDependencies.husky = pkg.devDependencies.husky || "^9";

// lint-staged
pkg["lint-staged"]["*.{js,json,md,css,html}"] = pkg["lint-staged"][
  "*.{js,json,md,css,html}"
] || ["prettier --write"];

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("✅ package.json updated safely.");
