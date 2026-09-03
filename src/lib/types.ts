import type { Timestamp } from 'firebase/firestore';

export type KeyStat = { value: string; label: string };
export type ExploreItem = { title: string; description: string };
export type ExploreSection = { title: string; summary: string; content: string; items: ExploreItem[] };
export type QuickBrief = { category: string; headline: string; quick_summary: string; three_things_to_know: string[]; key_number: KeyStat | null };
export type FullArticle = { headline: string; hook: string; in_20_seconds: string; what_happened: string; why_this_matters: string; bigger_picture: string; key_stats: KeyStat[]; explore_sections: ExploreSection[]; takeaways: string[]; quote: { text: string; speaker: string; role: string } | null };
export type Article = { id: string; schema_version: number; status: string; title: string; category: string; articleCategory?: string; quick_brief: QuickBrief; full_article: FullArticle; mediaUrls?: string[]; imageUrl?: string; authorId?: string; authorName?: string; authorAvatar?: string; authorEmail?: string; createdAt?: Timestamp; updatedAt?: Timestamp; publishedAt?: Timestamp; scheduledAt?: Timestamp; isFeatured?: boolean; isTodaysDrop?: boolean; deckPriority?: number; views?: number; likesCount?: number; commentsCount?: number; raw_input?: string };
export type LiveStream = { id: string; title: string; description?: string; roomName: string; hostId: string; hostName?: string; presenterId?: string; status: 'scheduled'|'live'|'ended'|'cancelled'; createdAt?: Timestamp; startedAt?: Timestamp; endedAt?: Timestamp; participantCount?: number; peakViewerCount?: number; isPublic?: boolean };
export type StudioUser = { uid: string; name?: string; email?: string; role?: string; photoUrl?: string; avatarUrl?: string };

