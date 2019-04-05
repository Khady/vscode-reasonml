import * as fs from "fs";
import flatMap = require("lodash.flatmap");
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import * as client from "vscode-languageclient";
import * as command from "./command";
import * as request from "./request";

const exists = promisify(fs.exists);
const readFile = promisify(fs.readFile);

const isWin = process.platform === "win32";

class ClientWindow implements vscode.Disposable {
  public readonly merlin: vscode.StatusBarItem;
  constructor() {
    this.merlin = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    this.merlin.text = "$(hubot) [loading]";
    this.merlin.command = "reason.showMerlinFiles";
    this.merlin.show();
    return this;
  }
  public dispose() {
    this.merlin.dispose();
  }
}

class ErrorHandler {
  public closed(): client.CloseAction {
    return client.CloseAction.DoNotRestart;
  }
  public error(): client.ErrorAction {
    return client.ErrorAction.Shutdown;
  }
}

async function isBucklescriptProject() {
  // TODO: we need to use workspace.workspaceFolders here and run LSP server per
  // root. For now we'll just run LSP per workspace.
  const root = vscode.workspace.rootPath;
  if (root == null) {
    return false;
  }

  const bsconfigJson = path.join(root, "bsconfig.json");

  if (await exists(bsconfigJson)) {
    return true;
  }

  return false;
}

async function isEsyProject() {
  const reasonConfig = vscode.workspace.getConfiguration("reason");
  const forceEsy = reasonConfig.get<boolean>("forceEsy", false);
  if (forceEsy) {
    return true;
  }

  // TODO: we need to use workspace.workspaceFolders here and run LSP server per
  // root. For now we'll just run LSP per workspace.
  const root = vscode.workspace.rootPath;
  if (root == null) {
    return false;
  }

  const esyJson = path.join(root, "esy.json");
  const packageJson = path.join(root, "package.json");
  if (await exists(esyJson)) {
    return true;
  } else if (await exists(packageJson)) {
    // package.json could be unrelated to esy, check if it has "esy" config
    // then.
    try {
      const data = await readFile(packageJson, "utf8");
      const json = JSON.parse(data);
      return json.esy != null;
    } catch (_e) {
      return false;
    }
  }

  return false;
}

async function getEsyConfig() {
  const root = vscode.workspace.rootPath;
  if (root == null) {
    return false;
  }

  let configFile = path.join(root, "esy.json");
  let isConfigFileExists = await exists(configFile);
  if (!isConfigFileExists) {
    configFile = path.join(root, "package.json");
  }

  try {
    const data = await readFile(configFile, "utf8");
    return JSON.parse(data);
  } catch (_e) {
    return null;
  }
}

async function isEsyConfiguredProperly() {
  const esyConfig = await getEsyConfig();
  const requiredDependencies = ["ocaml", "@opam/merlin-lsp"];

  if (!esyConfig) {
    vscode.window.showInformationMessage("LSP is unable to start. Couldn't find esy configuration");
    return false;
  }

  return requiredDependencies.every(dependency => {
    if (!esyConfig.devDependencies[dependency]) {
      vscode.window.showInformationMessage(`LSP is unable to start. Add "${dependency}" to your devDependencies`);
      return false;
    }

    return true;
  });
}

async function isConfuguredProperly(isEsyProject: boolean) {
  if (isEsyProject) {
    return await isEsyConfiguredProperly();
  }

  if (isBucklescriptProject()) return true;

  vscode.window.showInformationMessage(
    "LSP is unable to start. Extension couldn't detect type of the project. Provide esy or bucklescript configuration. More in README.",
  );
  return false;
}

export async function launch(context: vscode.ExtensionContext): Promise<void> {
  const isEasyProject = await isEsyProject();

  if (!isConfuguredProperly(isEasyProject)) return;

  return launchMerlinLsp(context, {
    useEsy: isEasyProject,
  });
}

function getPrebuiltExecutablesPath() {
  return path.join(__dirname, `../../../executables/${process.platform}`);
}

function getMerlinLspPath(useEsy: boolean) {
  let merlinLspPath = isWin ? "ocamlmerlin-lsp.exe" : "ocamlmerlin-lsp";

  if (!useEsy) {
    merlinLspPath = path.join(getPrebuiltExecutablesPath(), merlinLspPath);
  }

  return merlinLspPath;
}

function getMerlinLspOptions(options: { useEsy: boolean }) {
  const merlinLsp = getMerlinLspPath(options.useEsy);
  const pth = options.useEsy ? process.env.PATH : `${getPrebuiltExecutablesPath()}:${process.env.PATH}`;

  let run;
  if (options.useEsy) {
    run = {
      args: ["exec-command", "--include-current-env", merlinLsp],
      command: process.platform === "win32" ? "esy.cmd" : "esy",
    };
  } else {
    run = {
      args: [],
      command: merlinLsp,
    };
  }

  const serverOptions: client.ServerOptions = {
    debug: {
      ...run,
      options: {
        env: {
          ...process.env,
          MERLIN_LOG: "-",
          OCAMLFIND_CONF: "/dev/null",
          OCAMLRUNPARAM: "b",
          PATH: pth,
        },
      },
    },
    run: {
      ...run,
      options: {
        env: {
          ...process.env,
          MERLIN_LOG: "-",
          OCAMLFIND_CONF: "/dev/null",
          OCAMLRUNPARAM: "b",
          PATH: pth,
        },
      },
    },
  };
  return serverOptions;
}

export async function launchMerlinLsp(context: vscode.ExtensionContext, options: { useEsy: boolean }): Promise<void> {
  const serverOptions = getMerlinLspOptions(options);
  const reasonConfig = vscode.workspace.getConfiguration("reason");

  const languages = reasonConfig.get<string[]>("server.languages", ["ocaml", "reason"]);
  const documentSelector = flatMap(languages, (language: string) => [
    { language, scheme: "file" },
    { language, scheme: "untitled" },
  ]);
  const clientOptions: client.LanguageClientOptions = {
    diagnosticCollectionName: "ocamlmerlin-lsp",
    documentSelector,
    errorHandler: new ErrorHandler(),
    initializationOptions: reasonConfig,
    outputChannelName: "Merlin Language Server",
    stdioEncoding: "utf8",
    synchronize: {
      configurationSection: "reason",
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/.merlin"),
        vscode.workspace.createFileSystemWatcher("**/*.ml"),
        vscode.workspace.createFileSystemWatcher("**/*.re"),
        vscode.workspace.createFileSystemWatcher("**/command-exec"),
        vscode.workspace.createFileSystemWatcher("**/command-exec.bat"),
        vscode.workspace.createFileSystemWatcher("**/_build"),
        vscode.workspace.createFileSystemWatcher("**/_build/*"),
      ],
    },
  };
  const languageClient = new client.LanguageClient("Reason", serverOptions, clientOptions);
  const window = new ClientWindow();
  const session = languageClient.start();
  context.subscriptions.push(window);
  context.subscriptions.push(session);
  await languageClient.onReady();
  command.registerAll(context, languageClient);
  request.registerAll(context, languageClient);
  window.merlin.text = "$(hubot) [merlin]";
  window.merlin.tooltip = "merlin server online";
}
