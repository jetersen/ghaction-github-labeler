import fs from 'fs';
import nock from 'nock';
import {Inputs} from '../src/context';
import {Labeler, LabelStatus} from '../src/labeler';

process.env.GITHUB_REPOSITORY = 'crazy-max/ghaction-github-labeler';

function configFixture(fileName: string) {
  return fs.readFileSync(`${__dirname}/../${fileName}`);
}

function labelsFixture() {
  const content = fs.readFileSync(`${__dirname}/../.res/labels.json`).toString();
  return JSON.parse(content);
}

const cases = [
  [
    'labels.update.yml',
    {
      githubToken: process.env.GITHUB_TOKEN || 'test',
      yamlFile: '.res/labels.update.yml',
      skipDelete: true,
      dryRun: true,
      exclude: []
    },
    {
      skip: 13,
      exclude: 0,
      create: 1,
      update: 2,
      rename: 1,
      delete: 4,
      error: 0
    }
  ],
  [
    'labels.exclude1.yml',
    {
      githubToken: process.env.GITHUB_TOKEN || 'test',
      yamlFile: '.res/labels.exclude1.yml',
      skipDelete: true,
      dryRun: true,
      exclude: ['* d*', '*enhancement', '*fix']
    },
    {
      skip: 12,
      exclude: 5,
      create: 0,
      update: 1,
      rename: 0,
      delete: 2,
      error: 0
    }
  ],
  [
    'labels.exclude2.yml',
    {
      githubToken: process.env.GITHUB_TOKEN || 'test',
      yamlFile: '.res/labels.exclude2.yml',
      skipDelete: true,
      dryRun: true,
      exclude: ['*fix']
    },
    {
      skip: 17,
      exclude: 1,
      create: 0,
      update: 0,
      rename: 0,
      delete: 2,
      error: 0
    }
  ]
];

describe('run', () => {
  beforeAll(() => {
    nock.disableNetConnect();
    // nock.recorder.rec();
  });
  afterAll(() => {
    // nock.restore()
    nock.cleanAll();
    nock.enableNetConnect();
  });
  test.each(cases)('given %p', async (name, inputs, expected) => {
    const input = inputs as Inputs;

    nock('https://api.github.com').get('/repos/crazy-max/ghaction-github-labeler/labels').reply(200, labelsFixture());

    nock('https://api.github.com')
      .get(`/repos/crazy-max/ghaction-github-labeler/contents/${encodeURIComponent(input.yamlFile as string)}`)
      .reply(200, configFixture(input.yamlFile as string));

    const labeler = new Labeler(input);
    await labeler.printRepoLabels();
    console.log(
      (await labeler.labels).map(label => {
        return label.ghaction_log;
      })
    );

    const res = {
      skip: 0,
      exclude: 0,
      create: 0,
      update: 0,
      rename: 0,
      delete: 0,
      error: 0
    };
    for (const label of await labeler.labels) {
      switch (label.ghaction_status) {
        case LabelStatus.Exclude: {
          res.exclude++;
          break;
        }
        case LabelStatus.Create: {
          res.create++;
          break;
        }
        case LabelStatus.Update: {
          res.update++;
          break;
        }
        case LabelStatus.Rename: {
          res.rename++;
          break;
        }
        case LabelStatus.Delete: {
          res.delete++;
          break;
        }
        case LabelStatus.Skip: {
          res.skip++;
          break;
        }
        case LabelStatus.Error: {
          res.error++;
          break;
        }
      }
    }

    expect(res).toEqual(expected);
    expect(() => labeler.run()).not.toThrow();
  });
});
