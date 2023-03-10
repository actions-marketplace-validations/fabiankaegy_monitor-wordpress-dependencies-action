const path = require('path');
const { getInput, setFailed, startGroup, endGroup, debug } = require('@actions/core');
const { context, getOctokit } = require('@actions/github');
const { exec } = require('@actions/exec');
const DependencyPlugin = require('./lib/dependency-plugin.js');
const { fileExists, diffTable, toBool } = require('./lib/utils.js');

/**
 * @typedef {ReturnType<typeof import("@actions/github").getOctokit>} Octokit
 * @typedef {typeof import("@actions/github").context} ActionContext
 * @param {Octokit} octokit
 * @param {ActionContext} context
 * @param {string} token
 */
async function run(octokit, context, token) {
	const { owner, repo, number: pull_number } = context.issue;

	// const pr = (await octokit.pulls.get({ owner, repo, pull_number })).data;
	try {
		debug('pr' + JSON.stringify(context.payload, null, 2));
	} catch (e) {}

	let baseSha, baseRef;
	if (context.eventName == 'push') {
		baseSha = context.payload.before;
		baseRef = context.payload.ref;

		console.log(`Pushed new commit on top of ${baseRef} (${baseSha})`);
	} else if (context.eventName == 'pull_request' || context.eventName == 'pull_request_target') {
		const pr = context.payload.pull_request;
		baseSha = pr.base.sha;
		baseRef = pr.base.ref;

		console.log(`PR #${pull_number} is targeted at ${baseRef} (${baseRef})`);
	} else {
		throw new Error(
			`Unsupported eventName in github.context: ${context.eventName}. Only "pull_request", "pull_request_target", and "push" triggered workflows are currently supported.`
		);
	}

	if (getInput('cwd')) process.chdir(getInput('cwd'));

	const plugin = new DependencyPlugin({
		pattern: getInput('pattern') || '**/*.asset.php',
		exclude: getInput('exclude') || '{**/node_modules/**,**/vendor/**}',
	});

	const buildScript = getInput('build-script') || 'build';
	const cwd = process.cwd();

	let yarnLock = await fileExists(path.resolve(cwd, 'yarn.lock'));
	let pnpmLock = await fileExists(path.resolve(cwd, 'pnpm-lock.yaml'));
	let packageLock = await fileExists(path.resolve(cwd, 'package-lock.json'));

	let packageManager = 'npm';
	let installScript = 'npm install';
	if (yarnLock) {
		installScript = 'yarn --frozen-lockfile';
		packageManager = 'yarn';
	} else if (pnpmLock) {
		installScript = 'pnpm install --frozen-lockfile';
		packageManager = 'pnpm';
	} else if (packageLock) {
		installScript = 'npm ci';
	}

	startGroup(`[current] Install Dependencies`);
	console.log(`Installing using ${installScript}`);
	await exec(installScript);
	endGroup();

	startGroup(`[current] Build using ${packageManager}`);
	console.log(`Building using ${packageManager} run ${buildScript}`);
	await exec(`${packageManager} run ${buildScript}`);
	endGroup();

	// In case the build step alters a JSON-file, ....
	await exec(`git reset --hard`);

	const newSizes = await plugin.readFromDisk(cwd);

	startGroup(`[base] Checkout target branch`);
	try {
		if (!baseRef) throw Error('missing context.payload.pull_request.base.ref');
		await exec(`git fetch -n origin ${baseRef}`);
		console.log('successfully fetched base.ref');
	} catch (e) {
		console.log('fetching base.ref failed', e.message);
		try {
			await exec(`git fetch -n origin ${baseSha}`);
			console.log('successfully fetched base.sha');
		} catch (e) {
			console.log('fetching base.sha failed', e.message);
			try {
				await exec(`git fetch -n`);
			} catch (e) {
				console.log('fetch failed', e.message);
			}
		}
	}

	console.log('checking out and building base commit');
	try {
		if (!baseRef) throw Error('missing context.payload.base.ref');
		await exec(`git reset --hard ${baseRef}`);
	} catch (e) {
		await exec(`git reset --hard ${baseSha}`);
	}
	endGroup();

	const cleanScript = getInput('clean-script');
	if (cleanScript) {
		startGroup(`[base] Cleanup via ${packageManager} run ${cleanScript}`);
		await exec(`${packageManager} run ${cleanScript}`);
		endGroup();
	}

	startGroup(`[base] Install Dependencies`);

	yarnLock = await fileExists(path.resolve(cwd, 'yarn.lock'));
	pnpmLock = await fileExists(path.resolve(cwd, 'pnpm-lock.yaml'));
	packageLock = await fileExists(path.resolve(cwd, 'package-lock.json'));

	packageManager = 'npm';
	installScript = 'npm install';
	if (yarnLock) {
		installScript = `yarn --frozen-lockfile`;
		packageManager = `yarn`;
	} else if (pnpmLock) {
		installScript = `pnpm install --frozen-lockfile`;
		packageManager = `pnpm`;
	} else if (packageLock) {
		installScript = `npm ci`;
	}

	console.log(`Installing using ${installScript}`);
	await exec(installScript);
	endGroup();

	startGroup(`[base] Build using ${packageManager}`);
	await exec(`${packageManager} run ${buildScript}`);
	endGroup();

	// In case the build step alters a JSON-file, ....
	await exec(`git reset --hard`);

	const oldSizes = await plugin.readFromDisk(cwd);

	const diff = await plugin.getDiff(oldSizes, newSizes);

	const markdownDiff = diffTable(diff, {
		collapseUnchanged: toBool(getInput('collapse-unchanged')),
		omitUnchanged: toBool(getInput('omit-unchanged')),
	});

	let outputRawMarkdown = false;

	const commentInfo = {
		...context.repo,
		issue_number: pull_number
	};

	const comment = {
		...commentInfo,
		body:
			'#### Monitor WordPress Dependencies Action' +
			'\n\n' +
			'The <a href="https://github.com/fabiankaegy/monitor-wordpress-dependencies-action">monitor-wordpress-dependencies-action</a> action has detected some changed script dependencies between this branch and trunk. Please review and confirm the following are correct before merging.' +
			'\n\n' +
			markdownDiff +
			'\n\n<a href="https://github.com/fabiankaegy/monitor-wordpress-dependencies-action"><sub>monitor-wordpress-dependencies-action</sub></a>'
	};

	if (context.eventName !== 'pull_request' && context.eventName !== 'pull_request_target') {
		console.log('No PR associated with this action run. Not posting a check or comment.');
		outputRawMarkdown = false;
	} else {
		startGroup(`Updating stats PR comment`);
		let commentId;
		try {
			const comments = (await octokit.rest.issues.listComments(commentInfo)).data;
			for (let i = comments.length; i--; ) {
				const c = comments[i];
				if (c.user.type === 'Bot' && /<sub>monitor-wordpress-dependencies-action/.test(c.body)) {
					commentId = c.id;
					break;
				}
			}
		} catch (e) {
			console.log('Error checking for previous comments: ' + e.message);
		}

		if (commentId) {
			console.log(`Updating previous comment #${commentId}`);
			try {
				await octokit.rest.issues.updateComment({
					...context.repo,
					comment_id: commentId,
					body: comment.body
				});
			} catch (e) {
				console.log('Error editing previous comment: ' + e.message);
				commentId = null;
			}
		}

		// no previous or edit failed
		if (!commentId) {
			console.log('Creating new comment');
			try {
				await octokit.rest.issues.createComment(comment);
			} catch (e) {
				console.log(`Error creating comment: ${e.message}`);
				console.log(`Submitting a PR review comment instead...`);
				try {
					const issue = context.issue;
					await octokit.rest.pulls.createReview({
						owner: issue.owner,
						repo: issue.repo,
						pull_number: issue.number,
						event: 'COMMENT',
						body: comment.body
					});
				} catch (e) {
					console.log('Error creating PR review.');
					outputRawMarkdown = true;
				}
			}
		}
		endGroup();
	}

	if (outputRawMarkdown) {
		console.log(
			`
			Error: monitor-wordpress-dependencies-action was unable to comment on your PR.
			This can happen for PR's originating from a fork without write permissions.
			You can copy the size table directly into a comment using the markdown below:
			\n\n${comment.body}\n\n
		`.replace(/^(\t|  )+/gm, '')
		);
	}

	console.log('All done!');
}

/**
 * Create a check and return a function that updates (completes) it
 * @param {Octokit} octokit
 * @param {ActionContext} context
 */
async function createCheck(octokit, context) {
	const check = await octokit.checks.create({
		...context.repo,
		name: 'Monitor Generated WordPress Dependencies',
		head_sha: context.payload.pull_request.head.sha,
		status: 'in_progress'
	});

	return async (details) => {
		await octokit.checks.update({
			...context.repo,
			check_run_id: check.data.id,
			completed_at: new Date().toISOString(),
			status: 'completed',
			...details
		});
	};
}

(async () => {
	try {
		const token = getInput('repo-token');
		const octokit = getOctokit(token);
		await run(octokit, context, token);
	} catch (e) {
		setFailed(e.message);
	}
})();