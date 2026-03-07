const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const logger = require('./logger');
const storage = require('./storage');

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

async function checkForNewVideo(client) {
  const { YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID, YOUTUBE_DISCORD_CHANNEL_ID, YOUTUBE_PING_ROLE } =
    process.env;

  if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID || !YOUTUBE_DISCORD_CHANNEL_ID) {
    logger.warn('YouTube notifier: Missing YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID, or YOUTUBE_DISCORD_CHANNEL_ID — skipping poll');
    return;
  }

  logger.debug('YouTube: Polling for new videos', { channelId: YOUTUBE_CHANNEL_ID });

  try {
    const response = await axios.get(YT_SEARCH_URL, {
      params: {
        key: YOUTUBE_API_KEY,
        channelId: YOUTUBE_CHANNEL_ID,
        part: 'snippet',
        order: 'date',
        maxResults: 1,
        type: 'video',
      },
      timeout: 10000,
    });

    logger.debug('YouTube API response', {
      status: response.status,
      itemCount: response.data.items?.length ?? 0,
    });

    const items = response.data.items;
    if (!items || items.length === 0) {
      logger.debug('YouTube: No videos returned from API');
      return;
    }

    const latest = items[0];
    const videoId = latest.id.videoId;
    const lastVideoId = storage.getLastVideoId();

    if (videoId === lastVideoId) {
      logger.debug('YouTube: No new video since last poll', { videoId });
      return;
    }

    logger.info('YouTube: New video detected', {
      videoId,
      title: latest.snippet.title,
      publishedAt: latest.snippet.publishedAt,
    });

    storage.setLastVideoId(videoId);

    const discordChannel = await client.channels.fetch(YOUTUBE_DISCORD_CHANNEL_ID);
    if (!discordChannel) {
      logger.warn('YouTube: Target Discord channel not found', { YOUTUBE_DISCORD_CHANNEL_ID });
      return;
    }

    const publishedUnix = Math.floor(new Date(latest.snippet.publishedAt).getTime() / 1000);
    const thumbnail =
      latest.snippet.thumbnails?.maxres?.url ||
      latest.snippet.thumbnails?.high?.url ||
      latest.snippet.thumbnails?.default?.url;

    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle(`🎬 New Video: ${latest.snippet.title}`)
      .setURL(`https://www.youtube.com/watch?v=${videoId}`)
      .setDescription(
        latest.snippet.description
          ? latest.snippet.description.slice(0, 250) + (latest.snippet.description.length > 250 ? '…' : '')
          : '*No description provided.*'
      )
      .setThumbnail(thumbnail ?? null)
      .setImage(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`)
      .addFields(
        { name: 'Channel', value: latest.snippet.channelTitle, inline: true },
        { name: 'Published', value: `<t:${publishedUnix}:R>`, inline: true }
      )
      .setFooter({ text: 'YouTube Notifier' })
      .setTimestamp();

    await discordChannel.send({ embeds: [embed] });

    logger.info('YouTube: Notification posted', {
      videoId,
      discordChannelId: YOUTUBE_DISCORD_CHANNEL_ID,
    });
  } catch (err) {
    if (err.response) {
      logger.error('YouTube API error response', {
        status: err.response.status,
        data: err.response.data,
        channelId: YOUTUBE_CHANNEL_ID,
      });
    } else {
      logger.error('YouTube: Unexpected error during poll', {
        error: err.message,
        stack: err.stack,
        channelId: YOUTUBE_CHANNEL_ID,
      });
    }
  }
}

function startYouTubePoller(client) {
  const interval = parseInt(process.env.YOUTUBE_POLL_INTERVAL_MS, 10) || 10 * 60 * 1000;
  logger.info(`YouTube: Poller started (interval: ${interval / 1000}s)`);

  // Run immediately, then on every interval tick
  checkForNewVideo(client);
  setInterval(() => checkForNewVideo(client), interval);
}

module.exports = { startYouTubePoller, checkForNewVideo };
