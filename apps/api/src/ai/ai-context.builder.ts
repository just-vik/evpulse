import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AiContextBuilder {
  private readonly logger = new Logger(AiContextBuilder.name);
  private readonly groq: Groq | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const key = config.get<string>('GROQ_API_KEY');
    this.groq = key ? new Groq({ apiKey: key }) : null;
  }

  /**
   * Returns historical weekly summaries most semantically relevant to the question.
   * Falls back to most-recent summaries if vector search is unavailable.
   */
  async buildChatContext(
    vehicleId: string,
    question: string,
  ): Promise<{ historicalSummaries: string[] }> {
    const summaries = await this.vectorSearch(vehicleId, question);
    return { historicalSummaries: summaries };
  }

  private async vectorSearch(vehicleId: string, question: string): Promise<string[]> {
    if (!this.groq) return this.recentSummaries(vehicleId);

    try {
      const res = await this.groq.embeddings.create({
        model: 'nomic-embed-text-v1.5',
        input: question,
      });
      const embedding = res.data[0]?.embedding;
      if (!embedding) return this.recentSummaries(vehicleId);

      const vectorLiteral = `[${(embedding as number[]).join(',')}]`;
      const rows = await (this.prisma.$queryRawUnsafe as any)(
        `SELECT content
         FROM "user_context_embeddings"
         WHERE "vehicleId" = $1
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $2::vector(768)
         LIMIT 5`,
        vehicleId,
        vectorLiteral,
      );
      return rows.map(r => r.content);
    } catch (err: any) {
      this.logger.warn('Vector search failed, using recency fallback:', err?.message);
      return this.recentSummaries(vehicleId);
    }
  }

  private async recentSummaries(vehicleId: string): Promise<string[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ content: string }>>`
        SELECT content FROM "user_context_embeddings"
        WHERE "vehicleId" = ${vehicleId}
        ORDER BY "periodStart" DESC
        LIMIT 5
      `;
      return rows.map(r => r.content);
    } catch {
      return [];
    }
  }
}
