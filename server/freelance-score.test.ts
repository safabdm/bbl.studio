import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { importFreelanceJobs, parsePastedJob, scoreFreelanceJob } from './freelance-score.ts';

describe('freelance score + import', () => {
  it('scores beauty website jobs strongly and skips crypto', () => {
    const strong = scoreFreelanceJob({
      title: 'Med spa website + online booking',
      body: 'Need a modern website for our Irvine med spa with booking. US remote OK. Budget $2500 fixed.',
      location: 'Orange County, CA / remote',
      source: 'paste',
    });
    assert.equal(strong.tier, 'strong');
    assert.equal(strong.auto_submit, false);
    assert.equal(strong.status, 'draft_for_owner_review');
    assert.match(strong.proposal_draft, /draft_for_owner_review/);

    const skip = scoreFreelanceJob({
      title: 'React crypto trading dashboard NFT wallet',
      body: 'Build blockchain NFT wallet connect. Logo only also fine.',
    });
    assert.equal(skip.tier, 'skip');
  });

  it('imports paste and never auto-submits', () => {
    const paste = [
      'Title: Salon Squarespace rebuild',
      'Budget: $2k',
      'Location: Remote US',
      'Source: Upwork (manual paste)',
      '---',
      'Need a beauty salon website with booking on Squarespace.',
    ].join('\n');
    const parsed = parsePastedJob(paste);
    assert.match(parsed.title || '', /Salon/);
    const result = importFreelanceJobs({ paste });
    assert.equal(result.ok, true);
    assert.equal(result.auto_submit, false);
    assert.equal(result.jobs.length, 1);
    assert.ok(result.jobs[0]!.score >= 70);
  });
});
