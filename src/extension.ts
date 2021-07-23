/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from './logger';
import { DEFAULT_CONFIG, getConfigDisplayName, PlaywrightTestConfig, PlaywrightTestNPMPackage } from './playwrightTest';
import { TestCase, TestFile, testData } from './testTree';

const configuration = vscode.workspace.getConfiguration();

export async function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.workspaceFolders) {
    vscode.window.showWarningMessage('Playwright Test only works when a folder is opened.');
    return;
  }

  if (vscode.workspace.workspaceFolders.length !== 1) {
    vscode.window.showWarningMessage('Playwright Test only works in a single workspace folder.');
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders[0];

  const playwrightTestConfigsFromSettings = configuration.get<string[]>("playwright.configs");
  const playwrightTestConfigs: PlaywrightTestConfig[] = playwrightTestConfigsFromSettings?.length ? playwrightTestConfigsFromSettings : [DEFAULT_CONFIG];

  let playwrightTest: PlaywrightTestNPMPackage;
  try {
    playwrightTest = await PlaywrightTestNPMPackage.create(workspaceFolder.uri.path, configuration.get("playwright.cliPath")!);
  } catch (error) {
    vscode.window.showWarningMessage(error.toString());
    return;
  }

  for (let configIndex = 0; configIndex < playwrightTestConfigs.length; configIndex++) {
    const config = playwrightTestConfigs[configIndex];
    const tests = await playwrightTest.listTests(config, '', '.');
    if (!tests)
      continue;
    for (let projectsIndex = 0; projectsIndex < tests.config.projects.length; projectsIndex++) {
      const isDefault = projectsIndex === 0 && configIndex === 0;
      await createTestController(context, workspaceFolder, playwrightTest, config, tests.config.projects[projectsIndex].name, projectsIndex, isDefault);
    }
  }
}

async function createTestController(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder, playwrightTest: PlaywrightTestNPMPackage, config: PlaywrightTestConfig, projectName: string, projectIndex: number, isDefault: boolean) {
  const displayProjectAndConfigName = `${projectName}${config === DEFAULT_CONFIG ? '' : `[${config}]`}`;
  const controllerName = `Playwright Test ${displayProjectAndConfigName}`;
  logger.debug(`Creating test controller: ${controllerName}`);
  const ctrl = vscode.tests.createTestController('playwrightTestController' + (config === DEFAULT_CONFIG ? 'default' : config) + projectIndex, controllerName);
  ctrl.label = controllerName;
  context.subscriptions.push(ctrl);

  const makeRunHandler = (debug: boolean) => (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => {
    const queue: { test: vscode.TestItem; data: TestCase }[] = [];
    const run = ctrl.createTestRun(request);
    const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
      for (const test of tests) {
        if (request.exclude?.includes(test)) {
          continue;
        }

        const data = testData.get(test);
        if (data instanceof TestCase) {
          run.enqueued(test);
          queue.push({ test, data });
        } else {
          if (data instanceof TestFile && !data.didResolve) {
            await data.updateFromDisk(ctrl, test);
          }

          await discoverTests(gatherTestItems(test.children));
        }
      }
    };

    const runTestQueue = async () => {
      for (const { test, data } of queue) {
        run.appendOutput(`Running ${test.id}\r\n`);
        if (cancellation.isCancellationRequested) {
          run.skipped(test);
        } else {
          run.started(test);
          await data.run(test, run, debug);
        }

        run.appendOutput(`Completed ${test.id}\r\n`);
      }

      run.end();
    };

    discoverTests(request.include ?? gatherTestItems(ctrl.items)).then(runTestQueue);
  };


  ctrl.createRunProfile(`Run Tests in ${displayProjectAndConfigName}`, vscode.TestRunProfileKind.Run, makeRunHandler(false), isDefault);
  ctrl.createRunProfile(`Debug Tests in ${displayProjectAndConfigName}`, vscode.TestRunProfileKind.Debug, makeRunHandler(true), isDefault);

  ctrl.resolveHandler = async item => {
    if (!item) {
      await startIndexingWorkspace(workspaceFolder, ctrl, playwrightTest, config, projectName);
      return;
    }
    const data = testData.get(item);
    if (data instanceof TestFile) {
      await data.updateFromDisk(ctrl, item);
    }
  };

  function updateNodeForDocument(e: vscode.TextDocument) {
    if (!['.ts', '.js', '.mjs'].some(extension => e.uri.path.endsWith(extension))) {
      return;
    }

    const { file, data } = getOrCreateFile(ctrl, workspaceFolder, e.uri, playwrightTest, config, projectName);
    data.updateFromDisk(ctrl, file);
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidSaveTextDocument(updateNodeForDocument)
  );
}

function getOrCreateFile(controller: vscode.TestController, workspaceFolder: vscode.WorkspaceFolder, uri: vscode.Uri, playwrightTest: PlaywrightTestNPMPackage, config: PlaywrightTestConfig, projectName: string) {
  const existing = controller.items.get(uri.toString());
  if (existing) {
    return { file: existing, data: testData.get(existing) as TestFile };
  }
  const label = path.relative(workspaceFolder.uri.path, uri.path);
  const file = controller.createTestItem(uri.toString(), label, uri);
  controller.items.add(file);

  const data = new TestFile(playwrightTest, config, projectName);
  testData.set(file, data);

  file.canResolveChildren = true;
  return { file, data };
}

function gatherTestItems(collection: vscode.TestItemCollection) {
  const items: vscode.TestItem[] = [];
  collection.forEach(item => items.push(item));
  return items;
}

async function startIndexingWorkspace(workspaceFolder: vscode.WorkspaceFolder, controller: vscode.TestController, playwrightTest: PlaywrightTestNPMPackage, config: PlaywrightTestConfig, projectName: string) {
  const tests = await playwrightTest.listTests(config, '', workspaceFolder.uri.path);
  if (!tests)
    return;
  for (const suite of tests.suites)
    getOrCreateFile(controller, workspaceFolder, vscode.Uri.file(path.join(tests.config.rootDir, suite.file)), playwrightTest, config, projectName);
}