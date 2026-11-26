import { Logger } from '@nestjs/common';

// Keep test output readable: hide NestJS log lines while tests run.
Logger.overrideLogger(false);
