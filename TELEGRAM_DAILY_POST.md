# Telegram Daily Dictionary Post

The backend prepares Picture Dictionary Telegram posts every day for owner approval. Nothing is published to the channel until an owner approves it from Settings > Telegram Posts.

## Required Telegram setup

1. Create or reuse a Telegram bot with BotFather.
2. Add the bot as an administrator in your Telegram channel.
3. Set the channel username or numeric chat id in `TELEGRAM_CHANNEL_ID`.

## Environment variables

```bash
TELEGRAM_BOT_TOKEN=123456:bot-token-from-botfather
TELEGRAM_CHANNEL_ID=@your_channel_username
PUBLIC_API_BASE_URL=https://api.picturedictionary.cloud

# Optional defaults. Owners can also manage these in Settings > Telegram Posts.
TELEGRAM_DAILY_POST_ENABLED=true
TELEGRAM_DAILY_POST_TIME=08:00
TELEGRAM_DAILY_POST_TIME_ZONE=Asia/Phnom_Penh
TELEGRAM_POSTS_PER_DAY=1
TELEGRAM_POST_FROM_LANG=en
TELEGRAM_POST_TO_LANG=kh
```

`PUBLIC_API_BASE_URL` must be a public URL that Telegram can fetch. The post uses the existing `/share/item/:id/image` image and `/share/item/:id/:slug` page links.

## Owner workflow

1. Open `Settings > Telegram Posts` with an owner account.
2. Save the bot token, channel id, public API URL, and posts-per-day value.
3. Click `Generate pending now`, or let the daily scheduler prepare pending posts.
4. Edit captions or dates in the pending list.
5. Click `Approve & post` to publish to Telegram.

The published list defaults to the last 5 days and supports today or custom date-range filters.
