const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

function activate(context) {
  console.log("👉 [HaikuScript IDE Bridge]: Extension Waking Up Now!");

  const diagnosticCollection = vscode.languages.createDiagnosticCollection('haikuscript');
  context.subscriptions.push(diagnosticCollection);

  function validateDocument(document) {
    if (document.languageId !== 'haikuscript') return;

    const compilerPath = path.join(context.extensionPath, 'haiku.js');
    const command = `node "${compilerPath}" --json-errors "${document.fileName}"`;

    // Force the execution to run directly inside your project folder
    exec(command, { cwd: context.extensionPath }, (error, stdout, stderr) => {
      diagnosticCollection.clear();    

      // ADD THESE TWO DIAGNOSTIC LINES HERE:
      console.log("HaikuScript Compiler STDOUT:", stdout);
      console.log("HaikuScript Compiler ERROR:", error);

      if (error && stdout) {
        try {
          const errData = JSON.parse(stdout.trim());
          const line = document.lineAt(errData.line);
          const range = new vscode.Range(errData.line, 0, errData.line, line.text.length);
          const diagnostic = new vscode.Diagnostic(range, errData.message, vscode.DiagnosticSeverity.Error);

          diagnosticCollection.set(document.uri, [diagnostic]);
        } catch (e) {
          // Parsing fallback
        }
      } else if (stderr) {
        console.error("Compiler background crash:", stderr);
      }
    });
  }

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(validateDocument));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(validateDocument));
}

function deactivate() {}

module.exports = { activate, deactivate };