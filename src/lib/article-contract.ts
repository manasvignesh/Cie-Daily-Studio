import type { Article, FullArticle, QuickBrief } from './types';

export type ValidationIssue = { level: 'error'|'warning'; path: string; message: string };
const words = (value='') => value.trim().split(/\s+/).filter(Boolean).length;
const normalized = (value='') => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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

export function toPublishedPost(article: Article, identity:{uid:string;name:string;email:string;avatar?:string}) {
  const q=article.quick_brief, f=article.full_article, image=article.imageUrl||article.mediaUrls?.[0]||'';
  return {
    schema_version:2, status:'approved', category:'Article', articleCategory:q.category, title:q.headline,
    headline:q.headline, description:f.hook, hook:f.hook, quick_brief:q, full_article:f,
    mediaUrls:image?[image]:[], imageUrl:image, thumbnailUrl:image, coverImage:image,
    authorId:identity.uid, authorName:identity.name, authorEmail:identity.email, authorAvatar:identity.avatar||'',
    author:{name:identity.name,fullName:identity.name,email:identity.email,avatarUrl:identity.avatar||''},
    likedBy:[],bookmarkedBy:[],likesCount:0,commentsCount:0,isTodaysDrop:!!article.isFeatured,isFeatured:!!article.isFeatured,deckPriority:article.deckPriority??999,
    estimatedReadTime:Math.max(1,Math.ceil(words(JSON.stringify(f))/220)), raw_input:article.raw_input||'',
  };
}
