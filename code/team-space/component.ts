import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TeamSpaceService, TeamSpaceFile } from '../../services/team-space.service';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Subject, debounceTime, distinctUntilChanged, Subscription } from 'rxjs';
// @ts-ignore
import MarkdownIt from 'markdown-it';
import { OpenAiService } from '../../services/openai.service';

@Component({
  selector: 'app-team-space',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './team-space.component.html',
  styleUrl: './team-space.component.css'
})
export class TeamSpaceComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef;

  files: TeamSpaceFile[] = [];
  filteredFiles: TeamSpaceFile[] = [];
  selectedFile: TeamSpaceFile | null = null;
  selectedChunkHtml: SafeHtml | null = null;

  availableCategories: string[] = ['all'];
  activeCategory = 'all';
  searchQuery = '';
  lastUpdated = '';
  isSearching = false;

  // AI Mode
  isAiMode = true;
  aiQuery = '';
  aiMessages: { role: 'user' | 'assistant', content: string | SafeHtml }[] = [];
  isAiThinking = false;

  private searchSubject = new Subject<string>();
  private searchSubscription?: Subscription;

  constructor(
    private router: Router,
    private teamSpaceService: TeamSpaceService,
    private sanitizer: DomSanitizer,
    private openAiService: OpenAiService
  ) { }

  async ngOnInit() {
    const manifest = await this.teamSpaceService.getManifest();
    this.files = manifest.files;
    this.lastUpdated = manifest.updatedAt;

    // Dynamic Category Detection
    const cats = Array.from(new Set(this.files.map(f => f.category).filter(c => !!c)));
    this.availableCategories = ['all', ...cats.sort()];

    // Initialize debounced search
    this.searchSubscription = this.searchSubject.pipe(
      debounceTime(350),
      distinctUntilChanged()
    ).subscribe(() => {
      this.applyFilters(true);
    });

    this.applyFilters();

    // Default to README if it exists, otherwise first file
    const readme = this.files.find(f => f.id.toLowerCase() === 'readme' || f.id.toLowerCase().endsWith('/readme'));
    if (readme) {
      this.selectFile(readme, false); // Don't switch off AI mode on init
    } else if (this.files.length > 0) {
      this.selectFile(this.files[0], false);
    }
  }

  ngOnDestroy() {
    this.searchSubscription?.unsubscribe();
  }

  ngAfterViewChecked() {
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    try {
      if (this.scrollContainer) {
        this.scrollContainer.nativeElement.scrollTop = this.scrollContainer.nativeElement.scrollHeight;
      }
    } catch (err) { }
  }

  goBack() {
    this.router.navigate(['/']);
  }

  setCategory(cat: string) {
    this.activeCategory = cat;
    this.applyFilters();
  }

  onSearchChange(query: string) {
    this.searchSubject.next(query);
  }

  getMatchPercentage(score?: number): string {
    if (!score) return '0%';
    const percent = Math.min(Math.round(score * 100), 100);
    return `${percent}%`;
  }

  async applyFilters(isFromSearchInput: boolean = false) {
    let result = [...this.files];

    // Reset scores
    result.forEach(f => delete f.matchScore);

    if (this.activeCategory !== 'all') {
      result = result.filter(f => f.category === this.activeCategory);
    }

    if (this.searchQuery.trim()) {
      if (this.teamSpaceService.searchReady) {
        this.isSearching = true;
        try {
          const oramaRes = await this.teamSpaceService.searchIndex(this.searchQuery);

          if (oramaRes && oramaRes.hits && oramaRes.hits.length > 0) {
            const hitMap = new Map<string, number>();
            oramaRes.hits.forEach(h => hitMap.set((h.document as any).id, h.score));

            result = result
              .filter(f => hitMap.has(f.id))
              .map(f => ({ ...f, matchScore: hitMap.get(f.id) }))
              .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

            // Auto-select the top result if we just searched
            if (isFromSearchInput && result.length > 0) {
              this.selectFile(result[0]);
            }
          } else {
            const q = this.searchQuery.toLowerCase();
            result = result.filter(f =>
              f.title.toLowerCase().includes(q) ||
              (f.excerpt && f.excerpt.toLowerCase().includes(q))
            );
          }
        } catch (err) {
          console.error('Orama search error:', err);
        } finally {
          this.isSearching = false;
        }
      } else {
        const q = this.searchQuery.toLowerCase();
        result = result.filter(f =>
          f.title.toLowerCase().includes(q) ||
          (f.excerpt && f.excerpt.toLowerCase().includes(q))
        );
      }
    }

    this.filteredFiles = result;
  }

  md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true
  });

  async selectFile(file: TeamSpaceFile, switchMode: boolean = true) {
    if (switchMode) this.isAiMode = false;
    this.selectedFile = file;
    this.selectedChunkHtml = null;

    const chunk = await this.teamSpaceService.getChunk(file.id);
    if (chunk && chunk.html) {
      // Ensure any raw markdown inside the chunk is fully compiled to HTML
      const fullyRendered = this.md.render(chunk.html);
      this.selectedChunkHtml = this.sanitizer.bypassSecurityTrustHtml(fullyRendered);
    } else {
      this.selectedChunkHtml = this.sanitizer.bypassSecurityTrustHtml('<p><em>Could not load content for this note.</em></p>');
    }
  }

  toggleAiMode() {
    this.isAiMode = !this.isAiMode;
  }

  async onAskAi() {
    if (!this.aiQuery.trim() || this.isAiThinking) return;

    const userMsg = this.aiQuery.trim();
    this.aiMessages.push({ role: 'user', content: userMsg });
    this.aiQuery = '';
    this.isAiThinking = true;

    // 1. Search for context
    let context = "No specific team notes found for this query.";
    if (this.teamSpaceService.searchReady) {
      const oramaRes = await this.teamSpaceService.searchIndex(userMsg);
      if (oramaRes && oramaRes.hits && oramaRes.hits.length > 0) {
        // Collect text from top 3 hits
        const contextChunks: string[] = [];
        for (const hit of oramaRes.hits.slice(0, 3)) {
          const doc = hit.document as any;
          contextChunks.push(`Note: ${doc.title}\nContent: ${doc.content}`);
        }
        context = contextChunks.join('\n\n---\n\n');
      }
    }

    // 2. Ask AI
    const answer = await this.openAiService.askAi(userMsg, context);
    this.isAiThinking = false;

    if (answer) {
      const renderedAnswer = this.md.render(answer);
      this.aiMessages.push({
        role: 'assistant',
        content: this.sanitizer.bypassSecurityTrustHtml(renderedAnswer)
      });
    } else {
      this.aiMessages.push({
        role: 'assistant',
        content: "I'm sorry, I couldn't generate an answer."
      });
    }
  }

  getCategoryColor(category: string): string {
    const colors: Record<string, string> = {
      tech: '#eef2ff',
      casual: '#f0fdf4',
      learning: '#fdf4ff',
      default: '#f8fafc'
    };
    return colors[category] || colors['default'];
  }
}
