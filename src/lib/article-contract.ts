import type { Article, FullArticle, QuickBrief } from './types';

export type ValidationIssue = { level: 'error'|'warning'; path: string; message: string };
const words = (value='') => value.trim().split(/\s+/).filter(Boolean).length;
const normalized = (value='') => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const DEFAULT_EDITORIAL_FALLBACK_IMAGE =
  'https://images.unsplash.com/photo-1585829365295-ab7cd400c167?w=1200&auto=format&fit=crop&q=80';

export function emptyQuickBrief(): QuickBrief { return { category:'', headline:'', quick_summary:'', three_things_to_know:['','',''], key_number:null }; }
export function emptyFullArticle(): FullArticle { return { headline:'', hook:'', in_20_seconds:'', what_happened:'', why_this_matters:'', bigger_picture:'', key_stats:[], explore_sections:[], takeaways:[], quote:null }; }

export function validateArticle(article: Pick<Article,'quick_brief'|'full_article'>): ValidationIssue[] {
  const q=article.quick_brief || ({} as QuickBrief), f=article.full_article || ({} as FullArticle), out:ValidationIssue[]=[];
  if(!String(q.category || '').trim()) out.push({level:'error',path:'quick_brief.category',message:'Category is required.'});
  if(words(q.headline || '')<4) out.push({level:'error',path:'quick_brief.headline',message:'Quick Brief headline is too short.'});
  if(words(q.quick_summary || '')<20) out.push({level:'error',path:'quick_brief.quick_summary',message:'Quick Brief needs a meaningful summary.'});
  if((Array.isArray(q.three_things_to_know) ? q.three_things_to_know : []).filter(x=>words(x)>=4).length<3) out.push({level:'error',path:'quick_brief.three_things_to_know',message:'Add three substantive points.'});
  if(words(f.headline || '')<4) out.push({level:'error',path:'full_article.headline',message:'Full Article headline is required.'});
  if(words(f.hook || '')<8) out.push({level:'error',path:'full_article.hook',message:'Full Article needs a real hook.'});
  if(words(f.what_happened || '')<30) out.push({level:'error',path:'full_article.what_happened',message:'What happened is too short.'});
  if(words(f.why_this_matters || '')<25) out.push({level:'error',path:'full_article.why_this_matters',message:'Why this matters needs more context.'});
  const exploreSections = Array.isArray(f.explore_sections) ? f.explore_sections : [];
  const sections=exploreSections.filter(s=>words(`${s.content || ''} ${(Array.isArray(s.items) ? s.items : []).map(i=>i.description || '').join(' ')}`)>=25);
  if(sections.length<2) out.push({level:'error',path:'full_article.explore_sections',message:'Add at least two substantive story-specific sections.'});
  const takeaways = Array.isArray(f.takeaways) ? f.takeaways : [];
  if(takeaways.filter(x=>words(x)>=4).length<3) out.push({level:'error',path:'full_article.takeaways',message:'Add at least three final takeaways.'});
  const fullWords=words([f.hook || '',f.what_happened || '',f.why_this_matters || '',f.bigger_picture || '',...exploreSections.map(s=>s.content || ''),...takeaways].join(' '));
  if(fullWords<180) out.push({level:'warning',path:'full_article',message:`Full Article is only ${fullWords} words; target at least 180.`});
  if(normalized(q.quick_summary || '')===normalized(f.what_happened || '')||normalized(q.quick_summary || '')===normalized(f.in_20_seconds || '')) out.push({level:'warning',path:'content',message:'Quick Brief and Full Article appear suspiciously identical.'});
  return out;
}

export function validateAttribution(article: Partial<Article>): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const sourceType = String(article.sourceType || '').trim();
  const isOriginal = sourceType === 'original';
  if (!sourceType) out.push({level:'error',path:'sourceType',message:'Choose a source type.'});
  const rawDate = article.publishedAt as any;
  const date = rawDate?.toDate?.() || (rawDate ? new Date(String(rawDate)) : null);
  if (!date || Number.isNaN(date.getTime())) out.push({level:'error',path:'publishedAt',message:'Original publication date and time is required.'});
  if (isOriginal) {
    if (!String(article.authorName || '').trim()) out.push({level:'error',path:'authorName',message:'Author or editorial owner is required for original Breakpoint content.'});
    return out;
  }
  if (!String(article.originalPublisher || article.sourceName || '').trim()) out.push({level:'error',path:'originalPublisher',message:'Original publisher is required.'});
  const sourceUrl = String(article.originalSourceUrl || article.sourceUrl || '').trim();
  try {
    const parsed = new URL(sourceUrl);
    if (!['http:','https:'].includes(parsed.protocol)) throw new Error('unsafe protocol');
  } catch {
    out.push({level:'error',path:'originalSourceUrl',message:'A valid HTTP or HTTPS original source URL is required.'});
  }
  return out;
}

export function toPublishedPost(article: Article, identity:{uid:string;name:string;email:string;avatar?:string}) {
  const q=article.quick_brief, f=article.full_article;
  const image = article.imageUrl || article.mediaUrls?.[0] || 'https://images.unsplash.com/photo-1585829365295-ab7cd400c167?w=1200&auto=format&fit=crop&q=80';
  const sourceType = article.sourceType || 'external';
  const isOriginal = sourceType === 'original';
  const originalPublisher = isOriginal ? 'Breakpoint' : (article.originalPublisher || article.sourceName || 'Breakpoint Editorial');
  const originalSourceUrl = isOriginal ? '' : (article.originalSourceUrl || article.sourceUrl || '');
  return {
    schema_version:2, status:'approved', category:'Article', articleCategory:q.category, title:q.headline,
    headline:q.headline, description:f.hook, hook:f.hook, quick_brief:q, full_article:f,
    mediaUrls:image?[image]:['https://images.unsplash.com/photo-1585829365295-ab7cd400c167?w=1200&auto=format&fit=crop&q=80'], imageUrl:image, thumbnailUrl:image, coverImage:image,
    authorId:identity.uid, authorName:article.authorName||identity.name||'', authorEmail:identity.email, authorAvatar:identity.avatar||'',
    author:{name:identity.name,fullName:identity.name,email:identity.email,avatarUrl:identity.avatar||''},
    originalPublisher,
    originalSourceUrl,
    sourceName:originalPublisher,
    sourceUrl:originalSourceUrl,
    sourceType,
    breakpointEditor:article.breakpointEditor||'Breakpoint Editorial',
    likedBy:[],bookmarkedBy:[],likesCount:0,commentsCount:0,isTodaysDrop:!!article.isFeatured,isFeatured:!!article.isFeatured,deckPriority:article.deckPriority??999,
    estimatedReadTime:Math.max(1,Math.ceil(words(JSON.stringify(f))/220)), raw_input:article.raw_input||'',
  };
}
