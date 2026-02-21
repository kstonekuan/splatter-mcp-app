import { Animate } from "@openai/apps-sdk-ui/components/Transition";
import type React from "react";
import { useRef } from "react";
import { useCarouselAnimation } from "../hooks/useCarouselAnimation";
import { CarouselItem } from "./CarouselItem";

interface CarouselProps {
	results: Array<{ fruit: string; color: string }>;
	favorites?: string[];
	onSelectFruit: (fruit: string) => void;
	onToggleFavorite?: (fruit: string) => void;
}

export const Carousel: React.FC<CarouselProps> = ({
	results,
	favorites = [],
	onSelectFruit,
	onToggleFavorite,
}) => {
	const carouselContainerRef = useRef<HTMLDivElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	useCarouselAnimation(carouselContainerRef, scrollContainerRef);

	return (
		<div
			ref={scrollContainerRef}
			className="carousel-scroll-container w-full overflow-x-auto overflow-y-visible pl-8"
		>
			<div ref={carouselContainerRef} className="overflow-visible">
				<Animate className="flex gap-4">
					{results.map((item) => {
						return (
							<CarouselItem
								key={item.fruit}
								fruit={item.fruit}
								color={item.color ?? "bg-default/10"}
								isFavorite={favorites.includes(item.fruit)}
								onClick={() => onSelectFruit(item.fruit)}
								onToggleFavorite={
									onToggleFavorite
										? () => onToggleFavorite(item.fruit)
										: undefined
								}
							/>
						);
					})}
				</Animate>
			</div>
		</div>
	);
};
