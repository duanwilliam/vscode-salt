import * as vscode from "vscode";
import TelemetryReporter from '@vscode/extension-telemetry';
//import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

// node builtin packages
import * as crypto from 'crypto';
import * as fs from "fs";
import * as path from "path";

import { log } from "./utils/log";
import { openNewLog, openExistingLog, sendTelemetry, newReporter } from "./telemetry";
import { consentForm, consentFormPersonal, survey, thankYou } from "./forms";
import { supportedErrorcodes } from "./interventions";
import * as errorviz from "./interventions/errorviz";
// import { printAllItems } from "./printRust";

let intervalHandle: number | null = null;

const SENDINTERVAL = 25;
const NEWLOGINTERVAL = 1000;
const TWO_WEEKS = 1209600;
const YEAR = 31536000;
const suggestions = [
  /consider adding a leading/,
  /consider dereferencing here/,
  /consider removing deref here/,
  /consider dereferencing/,
  /consider borrowing here/,
  /consider .+borrowing here/,
  /consider removing the/,
  /unboxing the value/,
  /dereferencing the borrow/,
  /dereferencing the type/,
];

const initialStamp = Math.floor(Date.now() / 1000);
let visToggled = false;
let enableExt = true;
let noErrors = false;

let logDir: string | null = null;
let reporter: TelemetryReporter, logPath: string, linecnt: number,
stream: fs.WriteStream, output: vscode.LogOutputChannel, uuid: string;

export function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.workspaceFolders) {
    log.error("no workspace folders");
    return;
  }
  //FOR TESTING - reset all states
  // fs.rmSync(context.globalStorageUri.fsPath, {recursive: true});
  // context.globalState.update("participation", undefined);
  // context.globalState.update("startDate", undefined);
  // context.globalState.update("enableRevis", undefined);
  // context.globalState.update("uuid", undefined);
  // context.globalState.update("survey", undefined);


  if (logDir === null) {
    logDir = context.globalStorageUri.fsPath;

    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
  }

  //have they given an answer to the current consent form?
  //if not, render it!
  if (context.globalState.get("participation") === undefined){
    renderConsentForm(context);
  }

  //fixing mistake from last release - if participating, enable logging just once by setting a state
  if (context.globalState.get("participation") === true && context.globalState.get("globalEnable") === undefined){
    vscode.workspace.getConfiguration("salt").update("errorLogging", true, true);
    context.globalState.update("globalEnable", true);
  }
  
  //if logging is enabled, initialize reporter, log file, and line count
  if (vscode.workspace.getConfiguration("salt").get("errorLogging")
      && context.globalState.get("participation") === true){

    //if a year has passed, disable logging
    let startDate = context.globalState.get("startDate") as number;
    if (initialStamp > startDate + YEAR){
      vscode.workspace.getConfiguration("salt").update("errorLogging", false);
      context.globalState.update("participation", undefined);
      return;
    }

    //init telemetry reporter
    reporter = newReporter();

    //if 2 weeks have passed, re-enable tool
    //otherwise set enabled = false
    if (context.globalState.get("enableRevis") === false){
      if (initialStamp > startDate + TWO_WEEKS){
        context.globalState.update("enableRevis", true);
      }
      else {
        enableExt = false;
      }
    }

    [logPath, linecnt, stream] = openExistingLog(logDir, enableExt, initialStamp - startDate);
    output = vscode.window.createOutputChannel("SALT-logger", {log:true});
    uuid = context.globalState.get("uuid") as string;

    //check if telemetry is enabled globally
    if (!vscode.env.isTelemetryEnabled){
      vscode.window.showWarningMessage(
        "Please enable telemetry to participate in the study. Do this by going to Code > Settings > Settings and searching for 'telemetry'.");
    }
  }

  //settings.json config to get rustc err code
  const raconfig = vscode.workspace.getConfiguration("rust-analyzer");
  const useRustcErrorCode = raconfig.get<boolean>("diagnostics.useRustcErrorCode");
  if (!useRustcErrorCode) {
    vscode.window
      .showWarningMessage(
        "SALT wants to set `rust-analyzer.diagnostics.useRustcErrorCode` to true in settings.json.",
        "Allow",
        "I'll do it myself"
      )
      .then((sel) => {
        if (sel === "Allow") {
          raconfig.update("diagnostics.useRustcErrorCode", true);
        }
      });
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e === undefined) {
        return;
      }
      saveDiagnostics(e);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("salt.toggleVisualization", toggleVisualization)
  );

  //command to render consent form
  context.subscriptions.push(
    vscode.commands.registerCommand("salt.renderConsentForm",
      () => {
        renderConsentForm(context);
    }));

  //command to render survey
  context.subscriptions.push(
    vscode.commands.registerCommand("salt.renderSurvey",
      () => {
        if (context.globalState.get("participation") === true){
          renderSurvey(context);
        }
        else{
          vscode.window
          .showInformationMessage(
            "You may only view the survey after agreeing to the consent form.",
          );
        }
      }));
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "salt.clearAllVisualizations",
      clearAllVisualizations
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((_: vscode.TextDocument) => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        return;
      }

      // printAllItems(context);

      let doc = editor.document;
      if (vscode.workspace.getConfiguration("salt").get("errorLogging")
          && context.globalState.get("participation") === true && stream !== undefined){
        let savedAt = JSON.stringify({file: hashString(doc.fileName), savedAt: ((Date.now() / 1000) - initialStamp).toFixed(3)}) + "\n";
        stream.write(savedAt);
        output.append(savedAt);
        linecnt++;
        if (linecnt % SENDINTERVAL === 0){
          sendTelemetry(logPath, reporter);
          if (linecnt >= NEWLOGINTERVAL){
            [logPath, linecnt, stream] = openNewLog(logDir!, enableExt, uuid);
          }
        }
      }
    })
  );

  let timeoutHandle: NodeJS.Timeout | null = null;
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((_: vscode.DiagnosticChangeEvent) => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        return;
      }
      let doc = editor.document;
      //filter for only rust errors
      if (doc.languageId !== "rust") {
        return;
      }
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
      setTimeout(() => {
        saveDiagnostics(editor);
      }, 200);
      if (vscode.workspace.getConfiguration("salt").get("errorLogging")
          && context.globalState.get("participation") === true && stream !== undefined){
        //if logging is enabled, wait for diagnostics to load in
        let time = ((Date.now() / 1000) - initialStamp).toFixed(3);
        timeoutHandle = setTimeout(() => {
          //log errors
          logError(doc, time);
          //check if divisible by interval
          if (linecnt % SENDINTERVAL === 0){
            sendTelemetry(logPath, reporter);
            if (linecnt >= NEWLOGINTERVAL){
              [logPath, linecnt, stream] = openNewLog(logDir!, enableExt, uuid);
            }
          }
        }, 2000);
      }
    })
  );
}

/**
  * Renders the consent form
  */
function renderConsentForm(context: vscode.ExtensionContext){
  if (context.globalState.get("participation") === undefined
      || context.globalState.get("participation") === false){
    const panel = vscode.window.createWebviewPanel(
      'form',
      'SALT Study Consent Form',
      vscode.ViewColumn.One,
      {
        enableScripts: true
      }
    );
    panel.webview.html = consentForm;
  
    panel.webview.onDidReceiveMessage(
      message => {
        if (message.text === "yes"){
          context.globalState.update("participation", true);
          initStudy(context);
          renderSurvey(context);
  
          //init telemetry reporter and other values
          reporter = newReporter();
          [logPath, linecnt, stream] = openNewLog(logDir!, enableExt, uuid);
          output = vscode.window.createOutputChannel("SALT-logger", {log:true});
          uuid = context.globalState.get("uuid") as string;
          if (!vscode.env.isTelemetryEnabled){
            vscode.window.showWarningMessage(
              "Please enable telemetry to participate in the study. Do this by going to Code > Settings > Settings and searching for 'telemetry'.");
          }
        }
        else {
          context.globalState.update("participation", false);
        }
        panel.dispose();
      }
    );
  }
  else {
    //if already participating, render personal copy
    const panel = vscode.window.createWebviewPanel(
      'form',
      'SALT Study Consent Form',
      vscode.ViewColumn.One
    );
    panel.webview.html = consentFormPersonal;
  }
}

/**
 * Renders the survey
 */
function renderSurvey(context: vscode.ExtensionContext){
  const panel = vscode.window.createWebviewPanel(
    'form',
    'SALT Survey',
    vscode.ViewColumn.One,
    {
      enableScripts: true
    }
  );

  panel.webview.html = survey;

  panel.webview.onDidReceiveMessage(
    message => {
      context.globalState.update("survey", message.text);
      //write to latest log
      const fileCount = fs.readdirSync(logDir!).filter(f => path.extname(f) === ".json").length;
      const logPath = path.join(logDir!, `log${fileCount}.json`);
      fs.writeFileSync(logPath, JSON.stringify({survey: message.text}) + '\n', {flag: 'a'});
      panel.webview.html = thankYou;
    }
  );
}

/**
 * Initializes variables for the study
 */
function initStudy(context: vscode.ExtensionContext){
  //generate UUID
  const uuid = crypto.randomBytes(16).toString('hex');
  context.globalState.update("uuid", uuid);
  //store uuid in text file for easy access
  fs.writeFileSync(path.join(logDir!, "uuid.txt"), uuid + '\n', {flag: 'a'});

  //generate 50/50 chance of revis being active
  const rand = Math.random();
  if (rand < 0.5){
    //deactivate revis
    context.globalState.update("enableRevis", false);
    enableExt = false;
  }
  else {
    context.globalState.update("enableRevis", true);
    enableExt = true;
  }

  context.globalState.update("startDate", Math.floor(Date.now() / 1000));

  //set config to enable logging
  vscode.workspace.getConfiguration("salt").update("errorLogging", true, true);
  context.globalState.update("globalEnable", true);
}

/**
 * Creates a JSON object for each build and writes it to the log file
 * @param doc contains the current rust document
 * @param time to be subtracted from initial time
 */
function logError(doc: vscode.TextDocument, time: string){
  let diagnostics = vscode.languages
            .getDiagnostics(doc.uri)
            .filter((d) => {
              return (
                d.severity === vscode.DiagnosticSeverity.Error &&
                typeof d.code === "object" &&
                typeof d.code.value === "string"
              );
            });
  if (diagnostics.length === 0){
    //if duplicate successful build, return
    if (noErrors){
      return;
    }
    noErrors = true;
  }
  else {
    noErrors = false;
  }

  //for every error create a JSON object in the errors list
  let errors: $TSFIXME[] = [];
  for (const diag of diagnostics) {
    if (diag.code === undefined || typeof diag.code === "number" || typeof diag.code === "string") {
      log.error("unexpected diag.code type", typeof diag.code);
      return;
    }
    let code = diag.code.value;

    //syntax errors dont follow Rust error code conventions
    if (typeof code === "string" && code[0] !== 'E'){
      code = "Syntax";
    }

    //do any of the hints match our ref/deref patterns?
    let hint = "";
    if (diag.relatedInformation !== undefined){
      diag.relatedInformation.forEach((info) => {
        suggestions.forEach((suggestion) => {
          if (suggestion.test(info.message)){
            hint = info.message;
          }
        });
      });
    }

    //add error data to list
    errors.push({
      code: code,
      msg: hashString(diag.message),
      source: diag.source,
      hint: hint,
      range:{
        start: diag.range.start.line,
        end: diag.range.end.line
      }
    });
  }
  //get linecount of codebase
  countrs().then((count) => {
    //write to file
    const entry = JSON.stringify({
      file: hashString(doc.fileName),
      workspace: hashString(vscode.workspace.name!),
      seconds: time,
      revis: visToggled,
      length: doc.lineCount,
      numfiles: count,
      errors: errors
    }) + '\n';
    stream.write(entry);
    output.append(entry);
    linecnt++;
    visToggled = false;
  });
}

async function countrs(): Promise<number> {
  //get all Rust files in the workspace
  const files = await vscode.workspace.findFiles('**/*.rs');

  // let totalLines = 0;

  // //iterate through each file
  // for (const file of files) {
  //     const document = await vscode.workspace.openTextDocument(file);
  //     const lines = document.lineCount;
  //     totalLines += lines;
  // }

  // return totalLines;
  return files.length;
}

/**
 * Hashes + truncates strings to 8 characters
 * @param input string to be hashed
 * @returns hashed string
 */
function hashString(input: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(input);
  return hash.digest('hex').slice(0,8);
}

function saveDiagnostics(editor: vscode.TextEditor) {
  if (!enableExt){
    return;
  }
  const doc = editor.document;
  if (doc.languageId !== "rust") {
    // only supports rust
    return;
  }
  const diagnostics = vscode.languages
    .getDiagnostics(doc.uri)
    // only include _supported_ _rust_ _errors_
    .filter((d) => {
      return (
        d.source === "rustc" &&
        d.severity === vscode.DiagnosticSeverity.Error &&
        typeof d.code === "object" &&
        typeof d.code.value === "string" &&
        supportedErrorcodes.has(d.code.value)
      );
    });
  const newdiags: Array<[string, errorviz.DiagnosticInfo]> = [];
  const torefresh: string[] = [];
  for (const diag of diagnostics) {
    if (diag.code === undefined || typeof diag.code === "number" || typeof diag.code === "string") {
      log.error("unexpected diag.code type", typeof diag.code);
      return;
    }
    const erridx = diag.range.start.line.toString() + "_" + diag.code.value;
    newdiags.push([erridx, {
      diagnostics: diag,
      displayed: false,
      dectype: null,
      svg: null,
    }]);
    const odiag = errorviz.diags.get(erridx);
    if (odiag?.displayed) {
      // this is a displayed old diagnostics
      torefresh.push(erridx);
    }
  }
  // hide old diags and refresh displayed diagnostics
  errorviz.hideAllDiags(editor);
  errorviz.diags.clear();
  newdiags.forEach(([k, v]) => errorviz.diags.set(k, v));
  for (const d of torefresh) {
    log.info("reshow", d);
    errorviz.showDiag(editor, d);
  }
  errorviz.showTriangles(editor);
}

function toggleVisualization(editor: vscode.TextEditor, _: vscode.TextEditorEdit) {
  visToggled = true;
  const currline = editor.selection.active.line;
  const lines = [...errorviz.diags.keys()];
  const ontheline = lines.filter((i) => parseInt(i) === currline);
  if (!ontheline) {
    log.info("no diagnostics on line", currline + 1);
    return;
  }
  if (ontheline.length > 1) {
    vscode.window
      .showQuickPick(
        ontheline.map((id) => {
          const diag = errorviz.diags.get(id);
          const [line, ecode] = id.split("_", 2);
          const label = `${ecode} on line ${parseInt(line) + 1}`;
          const detail = diag?.diagnostics.message;
          return { label, detail, id };
        })
      )
      .then((selected) => {
        if (selected !== undefined) {
          errorviz.toggleDiag(editor, selected.id);
        }
      });
  } else {
    errorviz.toggleDiag(editor, ontheline[0]);
  }
}

function clearAllVisualizations(e: vscode.TextEditor, _: vscode.TextEditorEdit) {
  errorviz.hideAllDiags(e);
}

// This method is called when your extension is deactivated
export function deactivate() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
  }
}
