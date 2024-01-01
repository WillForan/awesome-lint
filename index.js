import process from 'node:process';
import path from 'node:path';
import isUrl from 'is-url-superb';
import isGithubUrl from 'is-github-url';
import ora from 'ora';
import {remark} from 'remark';
import {globbySync} from 'globby';
import rmfr from 'rmfr';
import {temporaryDirectory} from 'tempy';
import {readSync as readVFileSync} from 'to-vfile';
import vfileReporterPretty from 'vfile-reporter-pretty';
import {execa} from 'execa';
import config from './config.js';
import findReadmeFile from './lib/find-readme-file.js';
import codeOfConductRule from './rules/code-of-conduct.js';

const lint = options => {
	options = {
		...options,
		config: options.config ?? config,
		filename: options.filename ?? 'readme.md',
	};

	// 'awesome' and 'awesome-list' topic search will fail after timeout w/o connectivity
	// see rules/github.js
	if (options.offline) {
		options.config = options.config.filter(x => !/remark-lint:awesome-github/.test(x.name));
	}

	const readmeFile = globbySync(options.filename.replaceAll('\\', '/'), {caseSensitiveMatch: false})[0];

	if (!readmeFile) {
		return Promise.reject(new Error(`Couldn't find the file ${options.filename}`));
	}

	const readmeVFile = readVFileSync(path.resolve(readmeFile));
	const {dirname} = readmeVFile;
	const processTasks = [{
		vfile: readmeVFile,
		plugins: options.config,
	}];

	const codeOfConductFile = globbySync(['{code-of-conduct,code_of_conduct}.md', '.github/{code-of-conduct,code_of_conduct}.md'], {caseSensitiveMatch: false, cwd: dirname})[0];
	if (codeOfConductFile) {
		const codeOfConductVFile = readVFileSync(path.resolve(dirname, codeOfConductFile));
		codeOfConductVFile.repoURL = options.repoURL;
		processTasks.push({
			vfile: codeOfConductVFile,
			plugins: [codeOfConductRule],
		});
	}

	return Promise.all(processTasks.map(({vfile, plugins}) => remark().use(plugins).process(vfile)));
};

lint.report = async options => {
	const spinner = ora('Linting').start();

	try {
		await lint._report(options, spinner);
	} catch (error) {
		spinner.fail(error.message);
		process.exitCode = 1;
	}
};

lint._report = async (options, spinner) => {
	let temporary = null;

	if (isUrl(options.filename)) {
		if (options.offline) {
			throw new Error('Cannot lint URL while offline.');
		}

		if (!isGithubUrl(options.filename, {repository: true})) {
			throw new Error(`Invalid GitHub repo URL: ${options.filename}`);
		}

		temporary = temporaryDirectory();
		await execa('git', ['clone', '--depth', 1, '--', options.filename, temporary]);

		const readme = findReadmeFile(temporary);
		if (!readme) {
			await rmfr(temporary);
			throw new Error(`Unable to find valid readme for "${options.filename}"`);
		}

		options.repoURL = options.filename;
		options.filename = readme;
	}

	const vfiles = await lint(options);
	const messages = [];
	for (const vfile of vfiles) {
		vfile.path = path.basename(vfile.path);
		messages.push(...vfile.messages);
	}

	if (temporary) {
		await rmfr(temporary);
	}

	if (messages.length === 0) {
		spinner.succeed();

		if (options.reporter) {
			console.log(options.reporter([]));
		}

		return;
	}

	for (const message of messages) {
		message.fatal = true; // TODO: because of https://github.com/wooorm/remark-lint/issues/65
	}

	spinner.fail();
	process.exitCode = 1;

	const reporter = options.reporter || vfileReporterPretty;
	console.log(reporter(vfiles));
};

export default lint;
