import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';
import { marked } from 'marked';
import { create, insert, save } from '@orama/orama';

const CONTENT_DIR = './docs';
const OUTPUT_DIR = './src/assets/docs';

function slugify(filePath) {
  return filePath.replace(/\\/g, '/').replace(/\.md$/, '').replace(/\s+/g, '-');
}

async function run() {
  fs.mkdirSync(`${OUTPUT_DIR}/content`, { recursive: true });

  const files = await glob(`${CONTENT_DIR}/**/*.md`);

  const db = await create({
    schema: {
      id: 'string',
      title: 'string',
      excerpt: 'string',
      slug: 'string',
    }
  });

  const manifest = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    const html = marked(content);
    const slug = slugify(path.relative(CONTENT_DIR, file));
    const excerpt = content.replace(/[#*`>\-]/g, '').trim().slice(0, 300);

    // write individual content chunk
    fs.writeFileSync(
      `${OUTPUT_DIR}/content/${slug.replace(/\//g, '_')}.json`,
      JSON.stringify({ html, frontmatter })
    );

    manifest.push({
      slug,
      title: frontmatter.title || slug.split('/').pop(),
    });

    await insert(db, {
      id: slug,
      title: frontmatter.title || slug.split('/').pop(),
      excerpt,
      slug,
    });
  }

  const oramaIndex = await save(db);
  fs.writeFileSync(`${OUTPUT_DIR}/orama-index.json`, JSON.stringify(oramaIndex));
  fs.writeFileSync(`${OUTPUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));

  console.log(`✅ Built ${files.length} files`);
}

run();
