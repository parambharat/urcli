// node modules
import readline from 'readline';
// npm modules
import moment from 'moment';
import notifier from 'node-notifier';
import chalk from 'chalk';
import Table from 'cli-table2';
import PushBullet from 'pushbullet';
// our modules
import {api, config} from '../utils';

const {token, tokenAge, languages, certs} = config;
const requestBody = {};
const startTime = moment();
const assigned = [];
// The wait between calling submissionRequests().
const tickrate = 30000; // 30 seconds
const infoInterval = 10; // 10 * 30 seconds === 5 minutes

let options;

let error = '';
let accessToken = '';
let tick = 0;
let assignedCount = 0;
let assignedTotal = 0;
let requestId = 0;
let unreadFeedbacks = [];
let positions = [];
let projectIds = [];

function setPrompt() {
  // Clearing the screen.
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);

  // Warnings.
  if (error) {
    console.log(chalk.red('The API is currently not responding, or very slow to respond.'));
    console.log(chalk.red('The script will continue to run and try to get a connection.'));
    console.log(chalk.red(`Error Code: ${error}`));
  }
  error = '';
  const tokenExpiryWarning = moment(tokenAge).diff(moment(), 'days') < 5;
  const tokenExpires = moment(tokenAge).fromNow();
  console.log(chalk[tokenExpiryWarning ? 'red' : 'green'](`Token expires ${tokenExpires}`));

  // General info.
  console.log(chalk.green(`Uptime: ${chalk.white(startTime.fromNow(true))}\n`));
  // Positions in request queues.
  console.log(chalk.blue('You are queued up for:\n'));

  // Create a new table for projects that the user is queued up for
  const projectDetails = new Table({
    head: [
      {hAlign: 'center', content: 'pos'},
      {hAlign: 'center', content: 'id'},
      {hAlign: 'left', content: 'name'},
      {hAlign: 'center', content: 'lang'}],
    colWidths: [5, 7, 40, 7],
  });

  // Push projects, sorted by queue position, into the projectDetails table
  positions
    .sort((p1, p2) => p1.position - p2.position)
    .forEach((project) => {
      projectDetails.push([
        {hAlign: 'center', content: project.position},
        {hAlign: 'center', content: project.project_id},
        {hAlign: 'left', content: certs[project.project_id].name},
        {hAlign: 'center', content: project.language},
      ]);
    });

  // console.log a warning if max number of submissions are assigned, otherwise
  // console.log the projectDetails table
  if (!positions.length) {
    console.log(chalk.yellow(`    You have ${chalk.white(assignedCount)} (max) submissions assigned.\n`));
  } else {
    console.log(`${projectDetails.toString()}\n`);
  }

  // Info on when the next check will occur for queue position and feedbacks.
  if (tick % infoInterval === 0) {
    if (options.feedbacks) {
      console.log(chalk.blue('Checked for new feedbacks a few seconds ago...'));
    }
    console.log(chalk.blue('Checked the queue a few seconds ago...\n'));
  } else {
    const remainingSeconds = (infoInterval - (tick % infoInterval)) * (tickrate / 1000);
    const infoIsCheckedAt = moment().add(remainingSeconds, 'seconds');
    const humanReadableMessage = moment().to(infoIsCheckedAt);
    if (options.feedbacks) {
      console.log(chalk.blue(`Checking feedbacks ${humanReadableMessage}`));
    }
    console.log(chalk.blue(`Updating queue information ${humanReadableMessage}\n`));
  }

  // Assigned info.
  console.log(chalk.green(`Currently assigned: ${chalk.white(assignedCount)}`));
  console.log(chalk.green(`Total assigned: ${
    chalk.white(assignedTotal)} since ${startTime.format('dddd, MMMM Do YYYY, HH:mm')}\n`));
  // How to exit.
  console.log(chalk.green.dim(`Press ${
    chalk.white('ctrl+c')} to exit the queue cleanly by deleting the submission_request.`));
  console.log(chalk.green.dim(`Press ${
    chalk.white('ESC')} to suspend the script without deleting the submission_request.\n`));
}

function setupExitListeners() {
  // It's necessary to add a readline interface to catch <ctrl>-C on Windows.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // Exit cleanly on <ctrl>-C by deleting the submission_request.
  rl.on('SIGINT', () => {
    const task = 'delete';
    const id = requestId;
    api({token, task, id}).then(() => {
      console.log(chalk.green('Successfully deleted request and exited..'));
      process.exit(0);
    }).catch((err) => {
      console.error(chalk.red('Was unable to exit cleanly.'));
      console.error(err);
      process.exit(1);
    });
  });
  // Suspend on ESC and refresh the submission_request rather than deleting it.
  process.stdin.on('data', (key) => {
    /* eslint-disable eqeqeq */
    if (key == '\u001b') {
      const task = 'refresh';
      const id = requestId;
      api({token, task, id});
      console.log(chalk.green('Exited without deleting the submission_request...'));
      console.log(chalk.green('The current submission_request will expire in an hour.'));
      process.exit(0);
    }
  });
}

function validateProjectIds(ids) {
  const certIds = Object.keys(certs);
  if (ids === 'all') {
    return certIds;
  }
  const invalidIds = ids.filter(id => certIds.indexOf(id) === -1);
  if (invalidIds.length) {
    throw new Error(`Illegal Action: Not certified for project(s) ${[...invalidIds].join(', ')}`);
  }
  return ids;
}

function validateAccessToken() {
  if (options.push) {
    accessToken = options.push;
    const pusher = new PushBullet(accessToken);
    // Throw an error if we find no active devices to push to.
    pusher.devices((err, res) => {
      if (err) throw new Error(`Pushbullet error: ${err}`);
      if (!res.devices.length) throw new Error('Found no active devices to push to.');
    });
  }
}

function createRequestBody() {
  // Create a list of project/language pairs
  requestBody.projects = [];
  languages.forEach((language) => {
    /* eslint-disable camelcase */
    projectIds.forEach((project_id) => {
      requestBody.projects.push({project_id, language});
    });
  });
}

function assignmentNotification(projectInfo, submissionId) {
  const {name, id} = projectInfo;
  const title = `New Review Assigned! (${assignedCount})`;
  const message = `${moment().format('HH:mm')} - ${name} (${id})`;
  const sound = 'Ping';
  const open = `https://review.udacity.com/#!/submissions/${submissionId}`;
  notifier.notify({title, message, sound, open});

  // If the --push flag is set we push to active PushBullet devices
  if (accessToken) {
    const pusher = new PushBullet(accessToken);
    pusher.link({}, title, open, (err) => {
      if (err) throw new Error(`Pushbullet error: ${err}`);
    });
  }
}

async function checkAssigned() {
  const task = 'assigned';
  const assignedResponse = await api({token, task});

  if (assignedResponse.body.length) {
    assignedResponse.body
      .filter(s => assigned.indexOf(s.id) === -1)
      .forEach((s) => {
        // Only add it to the total number of assigned if it's been assigned
        // after the command was initiated.
        if (Date.parse(s.assigned_at) > Date.parse(startTime)) {
          assignedTotal += 1;
        }
        // Add the id of the newly assigned submission to the list of assigned
        // submissions.
        assigned.push(s.id);
        assignmentNotification(s.project, s.id);
      });
  }
}

async function checkPositions() {
  const task = 'position';
  const id = requestId;
  const positionResponse = await api({token, task, id});
  positions = positionResponse.body.error ? [] : positionResponse.body;
  setPrompt();
}

async function createSubmissionRequest() {
  const task = 'create';
  const body = requestBody;
  const createResponse = await api({token, task, body});
  requestId = createResponse.body.id;
  checkPositions();
  // Reset tick to reset the timers.
  tick = 0;
}

// This gets called if a submission_request is already active when the assign
// command is run. If the new project ids, input by the user, do not equal the
// project ids in the existing submission_request, we update the request.
let needToUpdate = (submissionRequest) => {
  needToUpdate = () => false;
  const submissionRequestProjectIds = submissionRequest.submission_request_projects
    .map(p => p.project_id);

  if (submissionRequestProjectIds.length !== projectIds.length) return true;

  const invalidIds = submissionRequestProjectIds
    .map(id => id.toString())
    .filter(id => projectIds.indexOf(id) === -1);
  return invalidIds.length;
};

async function updateSubmissionRequest() {
  const task = 'update';
  const id = requestId;
  const body = requestBody;
  const updateResponse = await api({token, task, id, body});
  requestId = updateResponse.body.id;
  checkPositions();
  // Reset tick to reset the timers.
  tick = 0;
}

async function checkRefresh(closedAt) {
  const closingIn = Date.parse(closedAt) - Date.now();
  // If it expires in less than 5 minutes we refresh.
  if (closingIn < 300000) {
    const task = 'refresh';
    const id = requestId;
    api({token, task, id});
  }
}

function feedbackNotification(rating, name, id) {
  const title = `New ${rating}-star Feedback!`;
  const message = `Project: ${name}`;
  const sound = 'Pop';
  const open = `https://review.udacity.com/#!/reviews/${id}`;
  notifier.notify({title, message, sound, open});
}

async function checkFeedbacks() {
  let task = 'stats';
  const stats = await api({token, task});
  const diff = stats.body.unread_count - unreadFeedbacks.length;
  if (diff > 0) {
    task = 'feedbacks';
    const feedbacksResponse = await api({token, task});
    unreadFeedbacks = feedbacksResponse.body.filter(fb => fb.read_at === null);
    // Notify the user of the new feedbacks.
    unreadFeedbacks.slice(-diff).forEach((fb) => {
      feedbackNotification(fb.rating, fb.project.name, fb.submission_id);
    });
  } else if (diff < 0) {
    // Note: If you check your feedbacks in the Reviews dashboard the unread
    // count always goes to 0. Therefore we can assume that a negative
    // difference between the current unread_count and the number of elements
    // in unreadFeedbacks, will mean that the new unread_count is 0.
    unreadFeedbacks = [];
  }
}

async function submissionRequests() {
  // Call API to check how many submissions are currently assigned.
  let task = 'count';
  try {
    const count = await api({token, task});
    if (assignedCount < count.body.assigned_count) {
      checkAssigned();
    }
    assignedCount = count.body.assigned_count;
    // If then the assignedCount is less than the maximum number of assignments
    // allowed, we go through checking the submission_request.
    if (assignedCount < 2) {
      task = 'get';
      const getResponse = await api({token, task});
      const submissionRequest = getResponse.body[0];
      // If there is no current submission_request we create a new one.
      if (!submissionRequest) {
        createSubmissionRequest();
      } else {
        requestId = submissionRequest.id;

        if (needToUpdate(submissionRequest)) {
          updateSubmissionRequest();
        } else {
          // Refresh the submission_request if it's is about to expire.
          checkRefresh(submissionRequest.closed_at);
          // Check the queue positions and for new feedbacks.
          if (tick % infoInterval === 0) {
            checkPositions();
            if (options.feedbacks) {
              checkFeedbacks();
            }
          }
        }
      }
    }
  } catch (e) {
    error = e.error.code;
  }
  setTimeout(() => {
    tick += 1;
    setPrompt();
    submissionRequests();
  }, tickrate);
}

export const assignCmd = (ids, opts) => {
  projectIds = validateProjectIds(ids);
  options = opts;
  validateAccessToken();
  setupExitListeners();
  createRequestBody();
  // Start the request loop.
  submissionRequests();
  setPrompt();
};
