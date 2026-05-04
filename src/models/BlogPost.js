const mongoose = require("mongoose");

const BlogPostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    excerpt: { type: String, default: "", trim: true },
    content: { type: String, default: "" },
    category: { type: String, default: "Education", trim: true },
    tags: [{ type: String, trim: true }],
    coverImageUrl: { type: String, default: "", trim: true },
    coverImageAlt: { type: String, default: "", trim: true },
    links: [
      {
        label: { type: String, default: "", trim: true },
        url: { type: String, default: "", trim: true },
      },
    ],
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    featured: { type: Boolean, default: false },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    authorName: { type: String, default: "", trim: true },
    publishedAt: { type: Date },
  },
  { timestamps: true }
);

BlogPostSchema.index({ status: 1, publishedAt: -1, createdAt: -1 });
BlogPostSchema.index({ category: 1, status: 1 });
BlogPostSchema.index({ title: "text", excerpt: "text", content: "text", tags: "text" });

module.exports = mongoose.model("BlogPost", BlogPostSchema);
