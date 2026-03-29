import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'path';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './common/database.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [resolve(process.cwd(), 'backend/.env'), resolve(process.cwd(), '.env')],
    }),
    DatabaseModule,
    AuthModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
