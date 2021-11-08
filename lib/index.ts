import path from "path";
import { defineConfig, Plugin, mergeConfig, UserConfig } from "vite";
import { readdirSync, lstatSync, readFileSync } from "fs";
const webExt = require("web-ext");
import { buildScript, BuildScriptConfig } from "./src/build-script";

type Manifest = any;

interface BrowserExtensionPluginOptions {
  /**
   * A function that returns your manifest as a JS object. It's a function so that the manifest can
   * be updated on hot reload!
   *
   * @example
   * () => require("./path/to/manifest.json")
   */
  manifest: (() => Manifest) | (() => Promise<Manifest>);

  /**
   * This path is where the manifest will be written to, and it is relative to Vite's output path
   * (default: `"manifest.json"`)
   */
  writeManifestTo?: string;

  /**
   * A path relative to Vite's root where all the extensions static assets can be found
   *
   * @example
   * "src/assets"
   */
  assets: string;

  /**
   * A path relative to the output directory (default: `"assets"`). All the files from the `assets`
   */
  writeAssetsTo?: string;

  /**
   * Whether or not to show logs. This is useful when modules aren't resolving and you need to debug
   * your paths
   */
  verbose?: boolean;

  /**
   * Used to include additional files, like content scripts, not mentioned in the final
   * `manifest.json`. Paths should be relative to Vite's `root` (or `process.cwd()` if not set)
   */
  additionalInputs?: string[];

  /**
   * See [`web-ext` docs](https://github.com/mozilla/web-ext#using-web-ext-in-nodejs-code) for options to configure how `web-ext` runs
   */
  webExtConfig?: any;

  /**
   * **Absolute paths** to files to watch.
   */
  watchFilePaths?: string[];
}

type BuildScriptCache = Omit<BuildScriptConfig, "vite" | "watch">;

export default function browserExtension<T>(
  options: BrowserExtensionPluginOptions
): Plugin {
  function log(...args: any[]) {
    process.stdout.write("\x1b[0m\x1b[2m");
    if (options?.verbose)
      console.log("[vite-plugin-web-ext-manifest]", ...args);
    process.stdout.write("\x1b[0m");
  }

  async function getManifest(): Promise<Manifest> {
    return typeof options.manifest === "function"
      ? options.manifest()
      : options.manifest;
  }

  function transformManifestInputs(manifestWithTs: any): {
    transformedManifest: any;
    generatedInputs: Record<string, string>;
    styleAssets: string[];
    generatedScriptInputs: BuildScriptCache[];
  } {
    const generatedInputs: Record<string, string> = {};
    const generatedScriptInputs: BuildScriptCache[] = [];
    const transformedManifest = JSON.parse(JSON.stringify(manifestWithTs));
    const styleAssets: string[] = [];

    const filenameToInput = (filename: string) =>
      filename.substring(0, filename.lastIndexOf("."));

    const filenameToPath = (filename: string) =>
      path.resolve(moduleRoot, filename);

    const filenameToCompiledFilename = (filename: string) =>
      filename.replace(/.(ts)$/, ".js").replace(/.(scss)$/, ".css");

    const transformHtml = (...manifestPath: string[]) => {
      const filename = manifestPath.reduce(
        (parent, path) => parent?.[path],
        transformedManifest
      );
      if (filename == null) return;
      generatedInputs[filenameToInput(filename)] = filenameToPath(filename);
    };

    const transformScripts = (object: any, key: string) => {
      const value = object?.[key];
      if (value == null) return;
      const scripts: string[] = typeof value === "string" ? [value] : value;
      const compiledScripts: string[] = [];
      scripts.forEach((script) => {
        generatedScriptInputs.push({
          inputAbsPath: filenameToPath(script),
          outputRelPath: filenameToInput(script),
        });
        compiledScripts.push(filenameToCompiledFilename(script));
      });

      object[key] = compiledScripts;
    };

    const transformModule = (object: any, key: string) => {
      const input = object?.[key];
      if (input == null) return;
      generatedInputs[filenameToInput(input)] = filenameToPath(input);
      object[key] = filenameToCompiledFilename(input);
    };

    const transformStylesheets = (object: any, key: string) => {
      const value = object?.[key];
      if (value == null) return;
      const styles: string[] = typeof value === "string" ? [value] : value;
      const compiledAssets: string[] = [];
      styles.forEach((style) => {
        if (!style.startsWith("generated:")) {
          styleAssets.push(style);
          log("Skip generated asset:", style);
          return;
        }
        compiledAssets.push(
          filenameToCompiledFilename(style).replace("generated:", "")
        );
      });
      object[key] = compiledAssets;
    };

    const scriptExtensions = [".ts", ".js"];
    const additionalInputTypes = options.additionalInputs?.reduce(
      (mapping, input) => {
        if (scriptExtensions.find((ext) => input.endsWith(ext))) {
          mapping.scripts.push(input);
        } else {
          mapping.assets.push(input);
        }
        return mapping;
      },
      {
        scripts: [] as string[],
        assets: [] as string[],
      }
    );

    // Html inputs
    transformHtml("browser_action", "default_popup");
    transformHtml("page_action", "default_popup");
    transformHtml("action", "default_popup"); // Manifest V3
    transformHtml("options_page");
    transformHtml("options_ui", "page");
    transformHtml("background", "page");
    transformHtml("sidebar_action", "default_panel");

    // JS inputs
    transformScripts(transformedManifest.background, "scripts");
    transformModule(transformedManifest.background, "service_worker"); // Manifest V3
    transformedManifest.content_scripts?.forEach((contentScript: string) => {
      transformScripts(contentScript, "js");
    });
    transformScripts(transformedManifest.user_scripts, "api_script");
    transformScripts(additionalInputTypes, "scripts");

    // CSS inputs
    transformedManifest.content_scripts?.forEach((contentScript: string) => {
      transformStylesheets(contentScript, "css");
    });
    transformStylesheets(additionalInputTypes, "assets");

    return {
      generatedInputs,
      transformedManifest,
      generatedScriptInputs,
      styleAssets,
    };
  }

  function getAllAssets(): string[] {
    const queue = [options.assets];
    log("Searching for assets in:", options.assets);
    const assets: string[] = [];
    while (queue.length > 0) {
      const folderName = queue.shift()!;
      const folderPath = path.resolve(moduleRoot, folderName);
      const children = readdirSync(folderPath).map((filename) =>
        path.join(folderName, filename)
      );
      for (const childName of children) {
        const childPath = path.resolve(moduleRoot, childName);
        if (lstatSync(childPath).isFile()) {
          log(`  > ${childName}`);
          assets.push(childName);
        } else {
          queue.push(childName);
        }
      }
    }
    return assets;
  }

  let outDir: string;
  let moduleRoot: string;
  let webExtRunner: any;
  let isWatching: boolean;
  let finalConfig: UserConfig;
  let scriptInputs: BuildScriptCache[];

  return {
    name: "vite-plugin-web-extension",

    config(viteConfig) {
      const webExtConfig = defineConfig({
        build: {
          terserOptions: {
            // As per chrome policy
            mangle: false,
          },
          rollupOptions: {
            output: {
              // Turn off chunking
              manualChunks: undefined,
              // Remove hashes from output filenames for consistent builds
              entryFileNames: "[name].js",
              chunkFileNames: "[name].js",
              assetFileNames: "[name].[ext]",
            },
          },
        },
      });
      finalConfig = mergeConfig(webExtConfig, viteConfig, true);
      return finalConfig;
    },

    configResolved(viteConfig) {
      moduleRoot = viteConfig.root;
      outDir = viteConfig.build.outDir;
      isWatching = viteConfig.inlineConfig.build?.watch === true;
    },

    async buildStart(rollupOptions) {
      // Generate manifest
      const manifestWithTs = await getManifest();
      log("Generated manifest:", manifestWithTs);

      // Generate inputs
      const {
        transformedManifest,
        generatedInputs,
        generatedScriptInputs,
        styleAssets,
      } = transformManifestInputs(manifestWithTs);
      rollupOptions.input = {
        ...rollupOptions.input,
        ...generatedInputs,
      };
      scriptInputs = generatedScriptInputs;

      // Assets
      const assets = [...styleAssets, ...getAllAssets()];
      assets.forEach((asset) => {
        this.emitFile({
          type: "asset",
          fileName: asset,
          source: readFileSync(path.resolve(moduleRoot, asset)),
        });
      });

      // Ignore vite's default of looking for a <root>/index.html
      // @ts-expect-error: doesn't want me to delete
      delete rollupOptions.input["0"];

      // Add stuff to the bundle
      const manifestContent = JSON.stringify(transformedManifest, null, 2);
      this.emitFile({
        type: "asset",
        fileName: options?.writeManifestTo ?? "manifest.json",
        name: "manifest.json",
        source: manifestContent,
      });
      log("Final manifest:", manifestContent);
      log("Final rollup inputs:", rollupOptions.input);

      if (isWatching) {
        options.watchFilePaths?.forEach((file) => this.addWatchFile(file));
        assets.forEach((asset) =>
          this.addWatchFile(path.resolve(moduleRoot, asset))
        );
      }
    },

    async buildEnd(err) {
      console.log("buildEnd");
      if (err != null) {
        log("Skipping script builds because of error", err);
        return;
      }
      log("Content scripts to build in lib mode:", scriptInputs);

      // for (const input of scriptInputs) {
      //   await build(input, finalConfig);
      // }
    },

    async closeBundle() {
      log("Content scripts to build in lib mode:", scriptInputs);
      for (const input of scriptInputs) {
        await buildScript({
          ...input,
          vite: finalConfig,
          watch: isWatching,
        });
      }
      // await build(scriptInputs[0], finalConfig);

      if (!isWatching) return;

      if (webExtRunner == null) {
        // https://github.com/mozilla/web-ext#using-web-ext-in-nodejs-code
        webExtRunner = await webExt.cmd.run(
          {
            ...options.webExtConfig,
            // No touch - can't exit the terminal if these are changed, so they cannot be overridden
            sourceDir: outDir,
            noReload: false,
            noInput: true,
          },
          { shouldExitProgram: true }
        );
      } else {
        webExtRunner.reloadAllExtensions();
      }
    },
  };
}

export function readJsonFile(absolutePath: string) {
  return JSON.parse(readFileSync(absolutePath, { encoding: "utf-8" }));
}
