const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Blog post registry — add new posts here
const POSTS = [
  {
    slug: 'why-live-transcription-matters',
    title: 'Why Live Transcription Changes Everything About How You Run Meetings',
    date: '2026-02-17',
    summary: 'Real-time transcription isn\'t just a nice-to-have — it fundamentally changes how teams collaborate during and after meetings. Here\'s why live matters more than post-meeting uploads.'
  },
  {
    slug: 'cross-meeting-intelligence-future-of-meetings',
    title: 'Cross-Meeting Intelligence: The Future of Business Meetings',
    date: '2026-02-15',
    summary: 'Meetings have a memory problem. Cross-Meeting Intelligence connects conversations across time, surfacing recurring topics, unresolved items, and follow-up patterns automatically.'
  },
  {
    slug: 'meetingmind-vs-modern-meetings',
    title: 'How MeetingMind Turns Chaotic Meetings into Clear Action Items',
    date: '2026-02-15',
    summary: 'Meetings don\'t have to end in confusion. Learn how AI-powered extraction transforms raw notes into tasks, owners, deadlines, and follow-up emails in seconds.'
  }
];

// GET /blog — list all posts
router.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'blog-list.html'));
});

// GET /blog/posts.json — post data for the list page
router.get('/posts.json', (_req, res) => {
  res.json(POSTS);
});

// GET /blog/:slug — individual post
router.get('/:slug', (req, res) => {
  const post = POSTS.find(p => p.slug === req.params.slug);
  if (!post) return res.status(404).send('Post not found');

  const filePath = path.join(__dirname, '..', 'views', `blog-post-${post.slug}.html`);
  if (!fs.existsSync(filePath)) return res.status(404).send('Post not found');

  res.sendFile(filePath);
});

module.exports = router;
