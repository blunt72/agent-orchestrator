import fs from "node:fs";
import path from "node:path";

export class TestDetector {
  public static detect(workspace: string, customCommand?: string): string | null {
    if (customCommand && customCommand.trim()) {
      return customCommand.trim();
    }

    // 1. Node.js (package.json)
    const pkgPath = path.join(workspace, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.scripts && pkg.scripts.test) {
          return "npm test";
        }
      } catch {}
      return "npm test";
    }

    // Check parent directories for monorepo package.json
    let parent = path.dirname(workspace);
    while (parent && parent !== path.dirname(parent)) {
      const parentPkg = path.join(parent, "package.json");
      if (fs.existsSync(parentPkg)) {
        return "npm test";
      }
      parent = path.dirname(parent);
    }

    // 2. Python
    if (
      fs.existsSync(path.join(workspace, "pytest.ini")) ||
      fs.existsSync(path.join(workspace, "pyproject.toml")) ||
      fs.existsSync(path.join(workspace, "setup.py"))
    ) {
      return "pytest";
    }

    // 3. Rust (Cargo.toml)
    if (fs.existsSync(path.join(workspace, "Cargo.toml"))) {
      return "cargo test";
    }

    // 4. Go (go.mod)
    if (fs.existsSync(path.join(workspace, "go.mod"))) {
      return "go test ./...";
    }

    // 5. Java Maven (pom.xml)
    if (fs.existsSync(path.join(workspace, "pom.xml"))) {
      return "mvn test";
    }

    // 6. Java/Kotlin Gradle (build.gradle)
    if (
      fs.existsSync(path.join(workspace, "build.gradle")) ||
      fs.existsSync(path.join(workspace, "build.gradle.kts"))
    ) {
      return "./gradlew test";
    }

    return null;
  }
}
