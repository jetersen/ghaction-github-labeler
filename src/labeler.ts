import fs from 'fs';
import matcher from 'matcher';
import * as yaml from 'js-yaml';
import * as core from '@actions/core';
import {Inputs} from './context';
import {GitHub, getOctokitOptions, context} from '@actions/github/lib/utils';
import {config} from '@probot/octokit-plugin-config';
export type Label = {
  name: string;
  color: string;
  description?: string;
  from_name?: string;
  ghaction_status?: LabelStatus;
  ghaction_log?: string;
};
export type Config = {
  labels: Label[];
};

export enum LabelStatus {
  Create,
  Update,
  Rename,
  Delete,
  Skip,
  Exclude,
  Error
}

export class Labeler {
  private readonly octokit;

  private readonly dryRun: boolean;
  private readonly skipDelete: boolean;
  private readonly exclude: string[];

  readonly labels: Promise<Label[]>;
  private readonly repoLabels: Promise<Label[]>;
  readonly fileLabels: Promise<Label[]>;

  constructor(inputs: Inputs) {
    const octokit = GitHub.plugin(config);
    this.octokit = new octokit(getOctokitOptions(inputs.githubToken));
    this.dryRun = inputs.dryRun;
    this.skipDelete = inputs.skipDelete;
    this.exclude = inputs.exclude;
    this.repoLabels = this.getRepoLabels();
    this.fileLabels = this.loadLabelsFromYAML(inputs.yamlFile);
    this.labels = this.computeActionLabels();
  }

  async run(): Promise<void> {
    let hasError: boolean = false;

    for (const label of await this.labels) {
      switch (label.ghaction_status) {
        case LabelStatus.Exclude: {
          this.logInfo(`${label.ghaction_log}`);
          break;
        }
        case LabelStatus.Create: {
          this.logInfo(`${label.ghaction_log}`);
          if (this.dryRun) {
            break;
          }
          hasError = !(await this.createLabel(label));
          break;
        }
        case LabelStatus.Update: {
          this.logInfo(`${label.ghaction_log}`);
          if (this.dryRun) {
            break;
          }
          hasError = !(await this.updateLabel(label));
          break;
        }
        case LabelStatus.Rename: {
          this.logInfo(`${label.ghaction_log}`);
          if (this.dryRun) {
            break;
          }
          hasError = !(await this.renameLabel(label));
          break;
        }
        case LabelStatus.Delete: {
          if (this.skipDelete) {
            this.logInfo(`⛔️ Skipping delete for '${label.name}' (inputs.skipDelete on)`);
            break;
          }
          this.logInfo(`${label.ghaction_log}`);
          if (this.dryRun) {
            break;
          }
          hasError = !(await this.deleteLabel(label));
          break;
        }
        case LabelStatus.Skip: {
          this.logInfo(`${label.ghaction_log}`);
          break;
        }
        case LabelStatus.Error: {
          this.logError(`${label.ghaction_log}`);
          hasError = true;
          break;
        }
        default: {
          this.logError(`🚫 '${label.name}' not processed`);
          hasError = true;
          break;
        }
      }
    }
    if (hasError) {
      throw new Error('Errors have occurred. Please check generated annotations.');
    }
  }

  private async createLabel(label: Label): Promise<boolean> {
    try {
      const params = {
        ...context.repo,
        name: label.name,
        color: label.color,
        description: label.description,
        mediaType: {
          previews: ['symmetra']
        }
      };
      await this.octokit.issues.createLabel(params);
      return true;
    } catch (err) {
      core.error(`Cannot create "${label.name}" label: ${err.message}`);
      return false;
    }
  }

  private async updateLabel(label: Label): Promise<boolean> {
    try {
      const params = {
        ...context.repo,
        name: label.name,
        color: label.color,
        description: label.description,
        mediaType: {
          previews: ['symmetra']
        }
      };
      await this.octokit.issues.updateLabel(params);
      return true;
    } catch (err) {
      core.error(`Cannot update "${label.name}" label: ${err.message}`);
      return false;
    }
  }

  private async renameLabel(label: Label): Promise<boolean> {
    try {
      const params = {
        ...context.repo,
        new_name: label.name,
        name: label.from_name,
        color: label.color,
        description: label.description,
        mediaType: {
          previews: ['symmetra']
        }
      };
      await this.octokit.issues.updateLabel(params);
      return true;
    } catch (err) {
      core.error(`Cannot rename "${label.from_name}" label: ${err.message}`);
      return false;
    }
  }

  private async deleteLabel(label: Label): Promise<boolean> {
    try {
      const params = {
        ...context.repo,
        name: label.name
      };
      await this.octokit.issues.deleteLabel(params);
      return true;
    } catch (err) {
      core.error(`Cannot delete "${label.name}" label: ${err.message}`);
      return false;
    }
  }

  private async getRepoLabels(): Promise<Label[]> {
    return (
      await this.octokit.paginate(this.octokit.issues.listLabelsForRepo, {
        ...context.repo
      })
    ).map(label => {
      return {
        name: label.name,
        color: label.color,
        description: label.description || ''
      };
    });
  }

  private async loadLabelsFromYAML(yamlFile: fs.PathLike): Promise<Label[]> {
    const {
      config: {labels}
    } = await this.octokit.config.get({
      ...context.repo,
      path: yamlFile,
      defaults(configs) {
        const output = [] as Label[];
        configs
          .map(config => {
            let labels = config.labels ? config.labels : config;
            if (Object.keys(labels).length === 0) labels = undefined;
            return {labels: labels || []};
          })
          .map(config => {
            config.labels.forEach(function (item: Label) {
              var existing = output.filter(function (v: Label, i) {
                return v.name == item.name;
              });
              if (existing.length) {
                var existingIndex = output.indexOf(existing[0]);
                output[existingIndex] = item;
              } else {
                output.push(item);
              }
            });
          });

        return {labels: output} as Config;
      }
    });
    return labels as Promise<Label[]>;
  }

  private async computeActionLabels(): Promise<Label[]> {
    let labels = Array<Label>();
    let exclusions: string[] = [];

    if (this.exclude.length > 0) {
      exclusions = matcher(
        (await this.repoLabels).map(label => label.name),
        this.exclude
      );
    }

    for (const fileLabel of await this.fileLabels) {
      const repoLabel = await this.getRepoLabel(fileLabel.name);

      // Rename
      if (fileLabel.from_name) {
        if (repoLabel?.name) {
          labels.push({
            ...fileLabel,
            ghaction_status: LabelStatus.Skip,
            ghaction_log: `✅ Skipping rename '${fileLabel.from_name}' label to '${fileLabel.name}'. Already exists`
          });
          continue;
        }

        const repoFromLabel = await this.getRepoLabel(fileLabel.from_name);
        if (repoFromLabel) {
          if (exclusions.includes(repoFromLabel.name)) {
            labels.push({
              ...repoFromLabel,
              ghaction_status: LabelStatus.Exclude,
              ghaction_log: `🚫️ Excluding '${repoFromLabel.name}' from rename.`
            });
            continue;
          }
          labels.push({
            ...fileLabel,
            ghaction_status: LabelStatus.Rename,
            ghaction_log: `✨ Renaming '${repoFromLabel.name}' label to '${fileLabel.name}' and set color '${fileLabel.color}'${fileLabel.description ? ` and desc '${fileLabel.description}'` : ''}`
          });
          continue;
        }
      }

      // Update
      if (repoLabel) {
        if (exclusions.includes(repoLabel.name)) {
          labels.push({
            ...fileLabel,
            ghaction_status: LabelStatus.Exclude,
            ghaction_log: `🚫️ Excluding '${fileLabel.name}' from update.`
          });
          continue;
        }

        if (fileLabel.color == repoLabel.color && fileLabel.description == repoLabel.description) {
          labels.push({
            ...fileLabel,
            ghaction_status: LabelStatus.Skip,
            ghaction_log: `✅ Skipping update for '${fileLabel.name}' label. Same color and description`
          });
          continue;
        }

        labels.push({
          ...fileLabel,
          ghaction_status: LabelStatus.Update,
          ghaction_log: `🔨 Updating '${fileLabel.name}' label with color '${fileLabel.color}'${fileLabel.description ? ` and desc '${fileLabel.description}'` : ''}`
        });
        continue;
      }

      // Create
      labels.push({
        ...fileLabel,
        ghaction_status: LabelStatus.Create,
        ghaction_log: `🎨 Creating '${fileLabel.name}' label with color '${fileLabel.color}'${fileLabel.description ? ` and desc '${fileLabel.description}'` : ''}`
      });
    }

    // Delete
    for (const repoLabel of await this.repoLabels) {
      if (await this.getFileLabel(repoLabel.name)) {
        continue;
      }
      if (exclusions.includes(repoLabel.name)) {
        labels.push({
          ...repoLabel,
          ghaction_status: LabelStatus.Exclude,
          ghaction_log: `🚫️ Excluding '${repoLabel.name}' from deletion.`
        });
        continue;
      }
      labels.push({
        ...repoLabel,
        ghaction_status: LabelStatus.Delete,
        ghaction_log: `🔫 Deleting '${repoLabel.name}'`
      });
    }

    return labels;
  }

  private async getRepoLabel(name: string): Promise<Label | undefined> {
    for (const repoLabel of await this.repoLabels) {
      if (name == repoLabel.name) {
        return repoLabel;
      }
    }
    return undefined;
  }

  private async getFileLabel(name: string): Promise<Label | undefined> {
    for (const fileLabel of await this.fileLabels) {
      if (name == fileLabel.name || name == fileLabel.from_name) {
        return fileLabel;
      }
    }
    return undefined;
  }

  async printRepoLabels() {
    let labels = Array<Label>();
    for (const repoLabel of await this.repoLabels) {
      labels.push({
        name: repoLabel.name,
        color: repoLabel.color,
        description: repoLabel.description
      });
    }
    core.info(`👉 Current labels\n${yaml.safeDump(labels).toString()}`);
  }

  private logInfo(message: string) {
    core.info(`${this.dryRun ? '[dryrun] ' : ''}${message}`);
  }

  private logError(message: string) {
    core.error(`${this.dryRun ? '[dryrun] ' : ''}${message}`);
  }
}
