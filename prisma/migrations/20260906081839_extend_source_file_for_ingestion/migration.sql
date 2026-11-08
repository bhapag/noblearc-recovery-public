/*
  Warnings:

  - Added the required column `contentHash` to the `source_files` table without a default value. This is not possible if the table is not empty.
  - Added the required column `mappingConfig` to the `source_files` table without a default value. This is not possible if the table is not empty.
  - Added the required column `mimeType` to the `source_files` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `source_files` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sizeBytes` to the `source_files` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storageKey` to the `source_files` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "source_files" ADD COLUMN     "aggregatorId" UUID,
ADD COLUMN     "contentHash" TEXT NOT NULL,
ADD COLUMN     "mappingConfig" JSONB NOT NULL,
ADD COLUMN     "mimeType" TEXT NOT NULL,
ADD COLUMN     "restaurantId" UUID NOT NULL,
ADD COLUMN     "sizeBytes" INTEGER NOT NULL,
ADD COLUMN     "storageKey" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "source_files_restaurantId_contentHash_idx" ON "source_files"("restaurantId", "contentHash");

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
