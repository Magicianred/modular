import { JSONSchemaForNPMPackageJsonFiles as PackageJson } from '@schemastore/package';
import { JSONSchemaForTheTypeScriptCompilerSConfigurationFile as TSConfig } from '@schemastore/tsconfig';

import rollup from 'rollup';
import rimraf from 'rimraf';
import * as path from 'path';

import execa from 'execa';

import postcss from 'rollup-plugin-postcss';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';

import * as ts from 'typescript';
import * as fs from 'fs';
import * as fse from 'fs-extra';

// from https://github.com/Microsoft/TypeScript/issues/6387
// a helper to output a readable message from a ts diagnostics object
function reportTSDiagnostics(diagnostics: ts.Diagnostic[]): void {
  diagnostics.forEach((diagnostic) => {
    let message = 'Error';
    if (diagnostic.file) {
      const where = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start as number,
      );
      message += ` ${diagnostic.file.fileName} ${where.line}, ${
        where.character + 1
      }`;
    }
    message +=
      ': ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    console.log(message);
  });
}

const extensions = ['.js', '.jsx', '.ts', '.tsx'];
const outputDirectory = 'dist';
const typescriptConfigFilename = 'tsconfig.json';
const packagesRoot = 'packages';
const excludeDirectories = [
  'create-modular-react-app',
  'eslint-config-modular-app',
  'modular-scripts',
  'modular-site',
  // "modular-site-header",
  'modular-views.macro',
  'tree-view-for-tests',
];

// TOD: process.chdir(MODULAR_ROOT)

const packageDirectoryNames = fs
  .readdirSync(packagesRoot, { withFileTypes: true })
  .filter((directoryEntry) => directoryEntry.isDirectory())
  .map((directory) => directory.name);

const rootPackageJsonDependencies =
  (JSON.parse(fs.readFileSync('package.json', 'utf8')) as PackageJson)
    .dependencies || {};

const packageJsons: { [key: string]: PackageJson } = {};
const packageJsonsByDirectoryName: {
  [key: string]: PackageJson;
} = {};

for (let i = 0; i < packageDirectoryNames.length; i++) {
  const pathToPackageJson = path.join(
    packagesRoot,
    packageDirectoryNames[i],
    'package.json',
  );
  if (fs.existsSync(pathToPackageJson)) {
    const packageJson = JSON.parse(
      fs.readFileSync(pathToPackageJson, 'utf8'),
    ) as PackageJson;
    packageJsons[packageJson.name as string] = packageJson;
    packageJsonsByDirectoryName[packageDirectoryNames[i]] = packageJson;
  }
}

const publicPackageJsons: {
  [key: string]: PackageJson;
} = {};

const typescriptConfig: TSConfig = {};
// validate tsconfig
{
  // Extract configuration from config file and parse JSON,
  // after removing comments. Just a fancier JSON.parse
  const result = ts.parseConfigFileTextToJson(
    typescriptConfigFilename,
    fs.readFileSync(typescriptConfigFilename, 'utf8').toString(),
  );
  const configObject = result.config as TSConfig | null;

  if (!configObject) {
    reportTSDiagnostics([result.error as ts.Diagnostic]);
    process.exit(1);
  }
  Object.assign(typescriptConfig, configObject);
  Object.assign(typescriptConfig.compilerOptions, {
    declarationDir: outputDirectory,
    noEmit: false,
    noEmitOnError: false,
    declaration: true,
    emitDeclarationOnly: true,
    // TODO: argue over this
    strict: false,
  });
  // todo: probably want to add 'exclude' here too
}

export default async function build(directoryName: string): Promise<boolean> {
  // TODO: - run whatever's in its scripts.build field too?

  const packageJson = packageJsonsByDirectoryName[directoryName];
  if (!packageJson || packageJson.private === true) {
    return false;
  }

  console.log(
    `building ${packageJson.name as string}... at packages/${directoryName}`,
  );

  const bundle = await rollup.rollup({
    // TODO: verify that .main exists
    input: path.join(packagesRoot, directoryName, packageJson.main as string),
    external: (id) => {
      // via tsdx
      if (id === 'babel-plugin-transform-async-to-promises/helpers') {
        // we want to inline these helpers
        return false;
      }
      return !id.startsWith('.') && !path.isAbsolute(id);
    },
    treeshake: {
      // via tsdx: Don't use getters and setters on plain objects.
      propertyReadSideEffects: false,
    },
    plugins: [
      resolve({
        extensions,
        browser: true,
        mainFields: ['module', 'main', 'browser'],
      }),
      commonjs({ include: /\/node_modules\// }),
      babel({
        babelHelpers: 'bundled',
        presets: [
          ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
          '@babel/preset-react',
        ],
        extensions,
        include: [`${packagesRoot}/**/*`],
        exclude: 'node_modules/**',
      }),
      postcss({ extract: false }),
      json(),
      {
        // via tsdx
        // Custom plugin that removes shebang from code because newer
        // versions of bublé bundle their own private version of `acorn`
        // and I don't know a way to patch in the option `allowHashBang`
        // to acorn. Taken from microbundle.
        // See: https://github.com/Rich-Harris/buble/pull/165
        name: 'strip-shebang',
        transform(code) {
          code = code.replace(/^#!(.*)/, '');

          return {
            code,
            map: null,
          };
        },
      },
    ],
  });

  const outputOptions = {
    freeze: false,
    sourcemap: true, // TODO: read this off env
    globals: { react: 'React', 'react-native': 'ReactNative' }, // why?
  };

  // we're going to use bundle.write() to actually generate the
  // output files, but first we're going to do a scan
  // to validate depndencies and collect some metadata for later
  const { output } = await bundle.generate(outputOptions);
  // TODO: we should use this loop to generate the files itself
  // to avoid the second scan, but it's ok for now I guess.

  const localImports: { [name: string]: string } = {};
  const missingDependencies: string[] = [];

  for (const chunkOrAsset of output) {
    if (chunkOrAsset.type === 'asset') {
      // TODO: what should happen here?
    } else {
      // it's a 'chunk' of source code, let's analyse it
      for (const imported of [
        ...chunkOrAsset.imports,
        ...chunkOrAsset.dynamicImports,
      ]) {
        // get the dependency (without references any inner modules)
        // TODO: we should probably throw an error if you try to reference
        // an inner module, until we land support for multiple entry points
        const importedPath = imported.split('/');
        const importedPackage: string =
          importedPath[0][0] === '@'
            ? `${importedPath[0]}/${importedPath[1]}`
            : importedPath[0];

        if (packageJsons[importedPackage]) {
          // This means we're importing from a local workspace
          // Let's collect the name and add it in the package.json
          // we publish to the registry
          // TODO: make sure local workspaces are NOT explicitly included in package.json
          if (packageJsons[importedPackage].private !== true) {
            localImports[importedPackage] = packageJsons[importedPackage]
              .version as string;
          } else {
            throw new Error(
              `referencing a private package: ${importedPackage}`,
            ); // todo - lineNo, filename
          }
        } else {
          // remote
          if (
            !packageJson.dependencies?.[importedPackage] &&
            !packageJson.peerDependencies?.[importedPackage]
            // not mentioned in the local package.json
          ) {
            if (rootPackageJsonDependencies[importedPackage]) {
              localImports[importedPackage] =
                rootPackageJsonDependencies[importedPackage];
            } else {
              // not mentioned in the root package.json either, so
              // let's collect its name and throw an error later
              // TODO: if it's in root's dev dependencies, should throw a
              // different kind of error
              // TODO: - should probably be ok with node builtins here
              missingDependencies.push(importedPackage);
            }
          }
        }
      }
    }
  }

  if (missingDependencies.length > 0) {
    throw new Error(
      `Missing dependencies: ${missingDependencies.join(', ')};`, // todo - lineNo, filename
    );
  }

  // write the bundles to disk

  await bundle.write({
    ...outputOptions,
    file: path.join(outputDirectory, directoryName, `${directoryName}.cjs.js`),
    format: 'cjs',
  });

  await bundle.write({
    ...outputOptions,
    file: path.join(outputDirectory, directoryName, `${directoryName}.es.js`),
    format: 'es',
  });

  // store the public facing package.json that we'll write later
  publicPackageJsons[directoryName] = {
    ...packageJson,
    main: path.join(outputDirectory, directoryName + '.cjs.js'),
    module: path.join(outputDirectory, directoryName + '.es.js'),
    typings: path.join(
      outputDirectory,
      (packageJson.main as string).replace('.ts', '.d.ts'),
    ),
    dependencies: {
      ...packageJson.dependencies,
      ...localImports,
    },
    files: [...new Set([...(packageJson.files || []), '/dist'])],
  };

  console.log(`built ${directoryName}`);
  return true;
}

// eslint-disable-next-line
async function run() {
  // cleanup
  rimraf.sync(outputDirectory);

  const builtPackages = [];
  for (const directoryName of packageDirectoryNames) {
    // do this sequentially
    if (excludeDirectories.includes(directoryName)) {
      continue;
    }
    const packageJson = packageJsonsByDirectoryName[directoryName];
    if (!packageJson || packageJson.private === true) {
      continue;
    }

    // generate js bundles
    await build(directoryName);
    // generate typescript definitions
    generateDTS(directoryName);
    //
    builtPackages.push(directoryName);
  }
  return;

  builtPackages.forEach((name: string) => {
    // clear output folder if already exists
    rimraf.sync(packagesRoot + '/' + name + '/' + outputDirectory);

    // move typings into the dist folder
    fse.copySync(
      outputDirectory + '/' + packagesRoot + '/' + name,
      packagesRoot + '/' + name + '/' + outputDirectory,
    );

    // move generated files to the dist folder
    fse.copySync(
      outputDirectory + '/' + name,
      packagesRoot + '/' + name + '/' + outputDirectory,
    );

    const originalPkgJsonContent = fs.readFileSync(
      packagesRoot + '/' + name + '/package.json',
      'utf8',
    );

    // switch in the special package.json
    fs.writeFileSync(
      packagesRoot + '/' + name + '/package.json',
      JSON.stringify(publicPackageJsons[name], null, '  '),
    );

    execa.sync('npm', ['pack'], {
      cwd: packagesRoot + '/' + name,
      stdin: process.stdin,
      stderr: process.stderr,
      stdout: process.stdout,
    });
    // now revert package.json
    fs.writeFileSync(
      packagesRoot + '/' + name + '/package.json',
      originalPkgJsonContent,
    );
    // and delete dist folders
    rimraf.sync(packagesRoot + '/' + name + '/' + outputDirectory);
  });
  rimraf.sync(outputDirectory);
  // move the tgz files to the dist folder
  builtPackages.forEach((name: string) => {
    const pkgName = `${(packageJsonsByDirectoryName[name].name as string)
      .replace('/', '-')
      .replace('@', '')}-${
      packageJsonsByDirectoryName[name].version as string
    }.tgz`;

    fse.moveSync(
      packagesRoot + '/' + name + '/' + pkgName,
      outputDirectory + '/' + pkgName,
    );
  });
  // et voila
}

function generateDTS(packageDirectory: string) {
  console.log('generating .d.ts files for', packageDirectory);

  // quick clone before we modify it
  const tsconfig = {
    ...typescriptConfig,
  };

  // add our custom stuff
  tsconfig.include = [`${packagesRoot}/${packageDirectory}`];

  tsconfig.exclude = [
    // all TS test files, regardless whether co-located or in test/ etc
    '**/*.stories.ts',
    '**/*.stories.tsx',
    '**/*.spec.ts',
    '**/*.test.ts',
    '**/*.spec.tsx',
    '**/*.test.tsx',
    '__tests__',
    // TS defaults below
    'node_modules',
    'bower_components',
    'jspm_packages',
    'tmp',
  ];

  // Extract config infromation
  const configParseResult = ts.parseJsonConfigFileContent(
    tsconfig,
    ts.sys,
    path.dirname(typescriptConfigFilename),
  );

  if (configParseResult.errors.length > 0) {
    reportTSDiagnostics(configParseResult.errors);
    process.exit(1);
  }

  const host = ts.createCompilerHost(configParseResult.options);
  host.writeFile = (fileName, contents) => {
    fse.mkdirpSync(path.dirname(fileName));
    fs.writeFileSync(fileName, contents);
  };

  // Compile
  const program = ts.createProgram(
    configParseResult.fileNames,
    configParseResult.options,
    host,
  );

  const emitResult = program.emit();

  // Report errors
  reportTSDiagnostics(
    ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics),
  );
}
