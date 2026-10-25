'use strict';
// Synthetic GitHub wire responses for independent acceptance. Never contacts GitHub.
const assert = require('node:assert/strict');
const API = 'https://api.github.com/repos/Maverlix777/agent-handoffs';
const WEB = 'https://github.com/Maverlix777/agent-handoffs/issues/';
function createIssueApi() {
  const state = { requests: [], issues: new Map(), comments: new Map(), nextIssue: 900, nextComment: 5000,
    failNextPost: null, metadataUnavailable: false, beforeRequest: null };
  state.issues.set(777, { number: 777, repository_url: API, html_url: WEB + '777', body: 'Existing synthetic task QA-1',
    labels: [{ name: 'worker:codex' }, { name: 'cloud:in-progress' }] });
  state.fetch = async (url, init = {}) => {
    const value = String(url);
    if (!value.startsWith(API) || value.startsWith(API + '/contents/')) return null;
    const method = init.method || 'GET'; const pathname = value.slice(API.length).split('?')[0];
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ method, pathname, body });
    if (state.beforeRequest) await state.beforeRequest({ method, pathname, body });
    if (pathname === '' && method === 'GET') return state.metadataUnavailable ? new Response('Unavailable', { status: 503 })
      : Response.json({ full_name: 'Maverlix777/agent-handoffs', private: true, visibility: 'private', has_issues: true });
    if (pathname === '/labels/idea' && method === 'GET') return Response.json({ name: 'idea' });
    if (method === 'POST') {
      assert.ok(pathname === '/issues' || /^\/issues\/\d+\/comments$/.test(pathname));
      const mode = state.failNextPost; state.failNextPost = null;
      if (mode === 'not_sent') throw new TypeError('Synthetic connection reset before remote acceptance');
      let created;
      if (pathname === '/issues') {
        assert.deepEqual(body.labels, ['idea'], 'new input must only save idea, never add worker/cloud-ready labels');
        assert.deepEqual(Object.keys(body).sort(), ['body', 'labels', 'title']);
        const number = state.nextIssue++;
        created = { number, repository_url: API, html_url: WEB + number, body: body.body, title: body.title,
          labels: body.labels.map((name) => ({ name })) };
        state.issues.set(number, created);
      } else {
        assert.deepEqual(Object.keys(body), ['body']);
        const issueNumber = Number(pathname.split('/')[2]); assert.ok(state.issues.has(issueNumber));
        const id = state.nextComment++;
        created = { id, body: body.body, issue_url: API + '/issues/' + issueNumber, html_url: WEB + issueNumber + '#issuecomment-' + id };
        state.comments.set(id, created);
      }
      if (mode === 'accepted') throw new TypeError('Synthetic response lost after remote acceptance');
      return Response.json(created, { status: 201 });
    }
    if (method === 'GET' && pathname === '/issues') return Response.json([...state.issues.values()]);
    const comments = /^\/issues\/(\d+)\/comments$/.exec(pathname);
    if (method === 'GET' && comments) return Response.json([...state.comments.values()].filter((entry) => entry.issue_url.endsWith('/' + comments[1])));
    const comment = /^\/issues\/comments\/(\d+)$/.exec(pathname);
    if (method === 'GET' && comment) return Response.json(state.comments.get(Number(comment[1])) || {}, { status: state.comments.has(Number(comment[1])) ? 200 : 404 });
    const issue = /^\/issues\/(\d+)$/.exec(pathname);
    if (method === 'GET' && issue) return Response.json(state.issues.get(Number(issue[1])) || {}, { status: state.issues.has(Number(issue[1])) ? 200 : 404 });
    throw new Error('Unexpected synthetic GitHub route: ' + method + ' ' + pathname);
  };
  state.postCount = () => state.requests.filter((entry) => entry.method === 'POST').length;
  return state;
}
module.exports = { createIssueApi };
