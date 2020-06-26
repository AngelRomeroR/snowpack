import merge from 'deepmerge';
import {EventEmitter} from 'events';
import execa from 'execa';
import {promises as fs} from 'fs';
import glob from 'glob';
import * as colors from 'kleur/colors';
import mkdirp from 'mkdirp';
import npmRunPath from 'npm-run-path';
import path from 'path';
import rimraf from 'rimraf';
import {SnowpackBuildMap, BuildResult, SnowpackSourceFile} from '../config';
import {transformFileImports} from '../rewrite-imports';
import {printStats} from '../stats-formatter';
import {CommandOptions, getExt} from '../util';
import {loadPlugins, createBuildPipeline} from '../plugins';
import {
  generateEnvModule,
  wrapCssModuleResponse,
  wrapEsmProxyResponse,
  wrapImportMeta,
} from './build-util';
import {stopEsbuild} from './esbuildPlugin';
import {createImportResolver} from './import-resolver';
import {getInstallTargets, run as installRunner} from './install';
import {paint} from './paint';

async function installOptimizedDependencies(
  allFilesToResolveImports: SnowpackBuildMap,
  installDest: string,
  commandOptions: CommandOptions,
) {
  console.log(colors.yellow('! optimizing dependencies...'));
  const installConfig = merge(commandOptions.config, {
    installOptions: {
      dest: installDest,
      env: {NODE_ENV: process.env.NODE_ENV || 'production'},
      treeshake: commandOptions.config.installOptions.treeshake ?? true,
    },
  });
  // 1. Scan imports from your final built JS files.
  const installTargets = await getInstallTargets(
    installConfig,
    Object.values(allFilesToResolveImports),
  );
  // 2. Install dependencies, based on the scan of your final build.
  const installResult = await installRunner({
    ...commandOptions,
    installTargets,
    config: installConfig,
  });
  // 3. Print stats immediate after install output.
  if (installResult.stats) {
    console.log(printStats(installResult.stats));
  }
  return installResult;
}

export async function command(commandOptions: CommandOptions) {
  const {cwd, config} = commandOptions;
  const messageBus = new EventEmitter();

  const {plugins, bundler, runCommands, buildCommands, mountedDirs} = loadPlugins(config);
  const isBundledHardcoded = config.devOptions.bundle !== undefined;
  const isBundled = isBundledHardcoded ? !!config.devOptions.bundle : !!bundler;

  const buildDirectoryLoc = isBundled ? path.join(cwd, `.build`) : config.devOptions.out;
  const internalFilesBuildLoc = path.join(buildDirectoryLoc, config.buildOptions.metaDir);
  const finalDirectoryLoc = config.devOptions.out;

  rimraf.sync(buildDirectoryLoc);
  mkdirp.sync(buildDirectoryLoc);
  mkdirp.sync(internalFilesBuildLoc);
  if (finalDirectoryLoc !== buildDirectoryLoc) {
    rimraf.sync(finalDirectoryLoc);
    mkdirp.sync(finalDirectoryLoc);
  }

  console.log = (...args) => {
    messageBus.emit('CONSOLE', {level: 'log', args});
  };
  console.warn = (...args) => {
    messageBus.emit('CONSOLE', {level: 'warn', args});
  };
  console.error = (...args) => {
    messageBus.emit('CONSOLE', {level: 'error', args});
  };
  let relDest = path.relative(cwd, config.devOptions.out);
  if (!relDest.startsWith(`..${path.sep}`)) {
    relDest = `.${path.sep}` + relDest;
  }
  paint(messageBus, Object.keys(config.scripts), {dest: relDest}, undefined);

  if (!isBundled) {
    messageBus.emit('WORKER_UPDATE', {id: 'bundle*', state: ['SKIP', 'dim']});
  }

  // 1. run scripts
  for (const {id, cmd} of runCommands) {
    messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
    const workerPromise = execa.command(cmd, {
      env: npmRunPath.env(),
      extendEnv: true,
      shell: true,
      cwd,
    });
    workerPromise.catch((err) => {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: err.toString()});
      messageBus.emit('WORKER_COMPLETE', {id, error: err});
    });
    workerPromise.then(() => {
      messageBus.emit('WORKER_COMPLETE', {id, error: null});
    });
    const {stdout, stderr} = workerPromise;
    stdout?.on('data', (b) => {
      let stdOutput = b.toString();
      if (stdOutput.includes('\u001bc') || stdOutput.includes('\x1Bc')) {
        messageBus.emit('WORKER_RESET', {id});
        stdOutput = stdOutput.replace(/\x1Bc/, '').replace(/\u001bc/, '');
      }
      if (id.endsWith(':tsc')) {
        if (stdOutput.includes('\u001bc') || stdOutput.includes('\x1Bc')) {
          messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
        }
        if (/Watching for file changes./gm.test(stdOutput)) {
          messageBus.emit('WORKER_UPDATE', {id, state: 'WATCHING'});
        }
        const errorMatch = stdOutput.match(/Found (\d+) error/);
        if (errorMatch && errorMatch[1] !== '0') {
          messageBus.emit('WORKER_UPDATE', {id, state: ['ERROR', 'red']});
        }
      }
      messageBus.emit('WORKER_MSG', {id, level: 'log', msg: stdOutput});
    });
    stderr?.on('data', (b) => {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: b.toString()});
    });
    await workerPromise;
  }

  // 2. Write the `import.meta.env` contents file to disk
  await fs.writeFile(path.join(internalFilesBuildLoc, 'env.js'), generateEnvModule('production'));

  // 3. create plugin build pipeline
  const buildPipeline = createBuildPipeline(plugins);

  // 4. identify files to be built
  const simpleOutputMap: {[src: string]: string} = {}; // input -> output mapping
  for (const {id, fromDisk, toUrl} of mountedDirs) {
    if (id === 'mount:web_modules') continue; // handle this later

    const src = path.resolve(cwd, fromDisk);
    const dest = path.resolve(buildDirectoryLoc, toUrl.replace(/^\//, ''));

    messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
    let allFiles;
    try {
      allFiles = glob.sync(`**/*`, {
        ignore: config.exclude,
        cwd: src,
        absolute: true,
        nodir: true,
        dot: true,
      });
      allFiles.forEach((f) => {
        simpleOutputMap[f] = f.replace(src, dest);
      });
    } catch (err) {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: err.toString()});
      messageBus.emit('WORKER_COMPLETE', {id, error: err});
    }
  }

  // 5. transform files with plugins
  const jsFilesToScan: SnowpackBuildMap = {};
  messageBus.emit('WORKER_UPDATE', {id: 'build', state: ['RUNNING', 'yellow']});

  for (const [src, dest] of Object.entries(simpleOutputMap)) {
    const output: SnowpackBuildMap = {}; // important: clear output for each src file to keep memory low
    const [basename] = path.basename(src).split('.');
    const srcExt = getExt(src);
    output[dest] = {...srcExt, code: await fs.readFile(src, 'utf8'), locOnDisk: src};

    // build CLI commands
    const buildCmd = buildCommands[srcExt.expandedExt] || buildCommands[srcExt.baseExt];
    if (buildCmd) {
      const {id, cmd} = buildCmd;
      let cmdWithFile = cmd.replace('$FILE', src);
      try {
        const {stdout, stderr} = await execa.command(cmdWithFile, {
          env: npmRunPath.env(),
          extendEnv: true,
          shell: true,
          input: output[dest].code,
          cwd,
        });
        if (stderr) {
          messageBus.emit('WORKER_MSG', {id, level: 'warn', msg: `${src}\n${stderr}`});
        }
        return {result: stdout};
      } catch (err) {
        messageBus.emit('WORKER_MSG', {id, level: 'error', msg: `${src}\n${err.stderr}`});
        messageBus.emit('WORKER_UPDATE', {id, state: ['ERROR', 'red']});
        return null;
      }
    }

    // build plugins (main build pipeline)
    for (const step of buildPipeline[srcExt.expandedExt] || buildPipeline[srcExt.baseExt] || []) {
      // TODO: remove transform() from plugin API when no longer used
      if (step.transform) {
        const urlPath = dest.substr(dest.length + 1);
        const {result} = await step.transform({contents: output[dest].code, urlPath, isDev: false});
        output[dest].code = result;
      }

      // TODO: move this CSS handling into Svelte/Vue plugins
      let hasCSSOutput = false;

      if (step.build) {
        let result: BuildResult;
        try {
          result = await step.build({
            code: output[dest].code,
            contents: output[dest].code,
            filePath: src,
            isDev: false,
          });
        } catch (err) {
          messageBus.emit('WORKER_MSG', {id: step.name, level: 'error', msg: err.message});
          messageBus.emit('WORKER_UPDATE', {id: step.name, state: ['ERROR', 'red']});
          return;
        }
        if (typeof result === 'string') {
          // single-output (assume extension is same)
          output[dest].code = result;
        } else if (result.result) {
          // DEPRECATED old output ({ result, resources })
          output[dest].code = result.result;
          output[dest].code = result.result;

          // handle CSS output for Svelte/Vue (TODO: remove this block when Svelte + Vue plugins upgraded to use multi-file output)
          if (typeof result.resources === 'object' && result.resources.css) {
            hasCSSOutput = true;

            const cssFile = path.join(path.dirname(dest), `${basename}.css`);
            output[cssFile] = {
              baseExt: '.css',
              expandedExt: '.css',
              code: result.resources.css,
              locOnDisk: src,
            };
          }
        } else if (typeof result === 'object') {
          // multi-file output ({ js: [string], css: [string], … })
          Object.entries(result as {[ext: string]: string}).forEach(([ext, code]) => {
            if (ext === '.css') hasCSSOutput = true;

            const newFile = path.join(path.dirname(dest), `${basename}.${ext}`);
            output[newFile] = {baseExt: ext, expandedExt: ext, code, locOnDisk: src};
          });
        }
      }

      // write file(s) to disk
      for (const [outputPath, file] of Object.entries(output)) {
        // final transformations
        switch (file.baseExt) {
          case '.js': {
            // TODO: move Svelte/Vue CSS handling into official plugins
            if (hasCSSOutput) {
              file.code = `import './${path.basename(outputPath)}';\n` + file.code;
            }
            file.code = wrapImportMeta({code: file.code, env: true, hmr: false, config});

            // JS files only: add to import scanner for install
            jsFilesToScan[outputPath] = file;
            break;
          }
          case '.html': {
            // replace %PUBLIC_URL% with baseUrl
            file.code = file.code.replace(/%PUBLIC_URL%\/?/g, config.buildOptions.baseUrl);
          }
        }

        // write to disk
        await fs.mkdir(path.dirname(outputPath), {recursive: true});
        await fs.writeFile(outputPath, file.code);
      }
    }
  }
  messageBus.emit('WORKER_COMPLETE', {id: 'build', error: null});

  stopEsbuild();

  const webModulesPath = (mountedDirs.find(({id}) => id === 'mount:web_modules') as any).toUrl;
  const installDest = path.join(buildDirectoryLoc, webModulesPath);
  const installResult = await installOptimizedDependencies(
    jsFilesToScan,
    installDest,
    commandOptions,
  );
  if (!installResult.success || installResult.hasError) {
    process.exit(1);
  }

  const allProxiedFiles = new Set<string>();
  for (const [outLoc, file] of Object.entries(jsFilesToScan)) {
    const resolveImportSpecifier = createImportResolver({
      fileLoc: file.locOnDisk!, // we’re confident these are reading from disk because we just read them
      webModulesPath,
      dependencyImportMap: installResult.importMap,
      isDev: false,
      isBundled,
      config,
    });
    const resolvedCode = await transformFileImports(file, (spec) => {
      // Try to resolve the specifier to a known URL in the project
      const resolvedImportUrl = resolveImportSpecifier(spec);
      if (resolvedImportUrl) {
        // We treat ".proxy.js" files special: we need to make sure that they exist on disk
        // in the final build, so we mark them to be written to disk at the next step.
        if (resolvedImportUrl.endsWith('.proxy.js')) {
          allProxiedFiles.add(
            resolvedImportUrl.startsWith('/')
              ? path.resolve(cwd, spec)
              : path.resolve(path.dirname(outLoc), spec),
          );
        }
        return resolvedImportUrl;
      }
      return spec;
    });
    await fs.mkdir(path.dirname(outLoc), {recursive: true});
    await fs.writeFile(outLoc, resolvedCode);
  }

  for (const proxiedFileLoc of allProxiedFiles) {
    const proxiedCode = await fs.readFile(proxiedFileLoc, {encoding: 'utf8'});
    const proxiedExt = path.extname(proxiedFileLoc);
    const proxiedUrl = proxiedFileLoc.substr(buildDirectoryLoc.length);
    const proxyCode = proxiedFileLoc.endsWith('.module.css')
      ? await wrapCssModuleResponse({
          url: proxiedUrl,
          code: proxiedCode,
          ext: proxiedExt,
          config,
        })
      : wrapEsmProxyResponse({
          url: proxiedUrl,
          code: proxiedCode,
          ext: proxiedExt,
          config,
        });
    const proxyFileLoc = proxiedFileLoc + '.proxy.js';
    await fs.writeFile(proxyFileLoc, proxyCode, {encoding: 'utf8'});
  }

  if (!isBundled) {
    messageBus.emit('WORKER_COMPLETE', {id: 'bundle:*', error: null});
    messageBus.emit('WORKER_UPDATE', {
      id: 'bundle:*',
      state: ['SKIP', isBundledHardcoded ? 'dim' : 'yellow'],
    });
    if (!isBundledHardcoded) {
      messageBus.emit('WORKER_MSG', {
        id: 'bundle:*',
        level: 'log',
        msg:
          `"plugins": ["@snowpack/plugin-webpack"]\n\n` +
          `Connect a bundler plugin to optimize your build for production.\n` +
          colors.dim(`Set "devOptions.bundle" configuration to false to remove this message.`),
      });
    }
  } else {
    try {
      messageBus.emit('WORKER_UPDATE', {id: 'bundle:*', state: ['RUNNING', 'yellow']});
      await bundler!.bundle!({
        srcDirectory: buildDirectoryLoc,
        destDirectory: finalDirectoryLoc,
        jsFilePaths: jsFilesToScan,
        log: (msg) => {
          messageBus.emit('WORKER_MSG', {id: 'bundle:*', level: 'log', msg});
        },
      });
      messageBus.emit('WORKER_COMPLETE', {id: 'bundle:*', error: null});
    } catch (err) {
      messageBus.emit('WORKER_MSG', {id: 'bundle:*', level: 'error', msg: err.toString()});
      messageBus.emit('WORKER_COMPLETE', {id: 'bundle:*', error: err});
    }
  }

  if (finalDirectoryLoc !== buildDirectoryLoc) {
    rimraf.sync(buildDirectoryLoc);
  }
}
