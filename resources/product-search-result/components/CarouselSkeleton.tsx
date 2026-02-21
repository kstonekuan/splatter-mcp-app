import type React from "react";

const SKELETON_COUNT = 6;
const skeletonPlaceholderIds = Array.from(
	{ length: SKELETON_COUNT },
	(_, placeholderIndex) => `skeleton-${placeholderIndex}`,
);

export const CarouselSkeleton: React.FC = () => {
	return (
		<div className="carousel-scroll-container w-full overflow-x-auto overflow-y-visible pl-8">
			<div className="overflow-hidden">
				<div className="flex gap-4">
					{skeletonPlaceholderIds.map((placeholderId) => (
						<div
							key={placeholderId}
							className="carousel-item shrink-0 size-52 rounded-xl border border-subtle animate-pulse bg-gray-100"
						></div>
					))}
				</div>
			</div>
		</div>
	);
};
